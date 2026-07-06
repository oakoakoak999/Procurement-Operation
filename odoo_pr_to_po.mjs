/**
 * ODOO PR → PO Workflow Automation
 * Exports Generate-PR-to-PO rows for a BU/profile, validates each against
 * the vendor + min-order reference sheet, and appends the result to that
 * BU's log sheet.
 *
 * --generate: after validation, also clicks "Generate to PO" in Odoo for PRs
 * that passed. Without it, the script only exports/validates/logs and never
 * touches Odoo, which is what makes default mode safe to run unattended.
 * The click runs once, AFTER all retried checkpoints, deliberately NOT
 * wrapped in withRetry: "Generate to PO" has no confirm dialog, so a
 * retry-driven re-click on the same batch would create duplicate real POs.
 *
 * --test (with --generate only): opens the Actions menu but stops before the
 * click, so a batch can be replayed against the same PRs without consuming
 * them into real POs.
 *
 * 2nd tier vendor: the reference sheet's "2nd tier Vendor" column holds
 * vendors a human has previously approved as a one-off (promoted via
 * promote_vendor_tier2.mjs). Vendor check passes on EITHER the 1st tier
 * Vendor Name/Code OR a 2nd tier match — tracked separately (Execute Log
 * column O) since a 2nd tier pass means "a human already approved this,"
 * not "meets the stated procurement policy."
 */

import { chromium } from 'playwright';
import XLSX from 'xlsx';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { selectPRRows, executeOdooAction, resetSelection } from './pr-row-actions.mjs';

// ─── LOAD .env ────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '.env');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ODOO_URL        = 'https://smarterp-uat.princhealth.com';
const DB_SELECTOR_URL = `${ODOO_URL}/web/database/selector`;
const USERNAME        = process.env.ODOO_USERNAME;
const PASSWORD        = process.env.ODOO_PASSWORD;
if (!USERNAME || !PASSWORD) throw new Error('ODOO_USERNAME / ODOO_PASSWORD not set in .env');
const PROFILES = {
  supply:   { buyer: 'SUPPLY_BUYER',   logTab: 'MEDSUPPLY' },
  medicine: { buyer: 'MEDICINE_BUYER', logTab: 'MEDICINE'  },
};
const _pos           = process.argv.slice(2).filter(a => !a.startsWith('--'));
const PROFILE_KEY    = _pos[0];
const TARGET_BU_CODE = _pos[1];
if (!PROFILE_KEY || !TARGET_BU_CODE)
  throw new Error('Usage: node odoo_pr_to_po.mjs <profile> <BU_CODE> [--headless] [--generate [--test]]\nProfiles: supply | medicine');

const BU_ODOO_PREFIX = {
  PPNP:  '[PPNP:00051]',
  PSV:   '[PSV:00052]',
  PPCH:  '[PPCH:00053]',
  PUTD:  '[PUTD:00055]',
  PSUV:  '[PSUV:00057]',
  PUTH:  '[PUTH:00058]',
  PLPN1: '[PLPN:00059]',
  PSSK:  '[PSSK:00061]',
  PCPN:  '[PCPN:00062]',
  PUBN:  '[PUBN:00064]',
  KBKJ:  '[KBKJ:00065]',
  PSNK:  '[PSNK:00067]',
  PPRP:  '[PPRP:00068]',
  PMDH:  '[PMDH:00069]',
  PLPN2: '[PLPN:00071]',
  PKPP:  '[PKPP:00072]',
  PKAN:  '[PKAN:00073]',
  PKRT:  '[PKRT:00074]',
  PPAT:  '[PPAT:00075]',
};
// Inverse map: '[PLPN:00059]' → 'PLPN1' — distinguishes BUs sharing the same letters
const PREFIX_TO_BU = Object.fromEntries(
  Object.entries(BU_ODOO_PREFIX).map(([code, prefix]) => [prefix, code])
);
// Each BU's own "<BUCODE> Log PR-PO 2026" sheet, living in its Drive folder
// under the shared PR2PO drive (replaces the single shared GSHEET_LOG_ID).
const BU_LOG_SHEETS = {
  PPNP:  '1QKgY5fh4aaGGrTzRJlO6z7nvu6IjzrGpOqo9UMsaLQs',
  PSV:   '1eiuzPvsS9li3H-81q_8A1l1BwJGenbxJGh0NHO_7Fzw',
  PPCH:  '1zfcWM58Hw_lOg3xQr983tSi9CJrohpNSjwX_DRwtpkY',
  PUTD:  '18zlyVh1afnfhXMBRqlY52ELU6Pmp2M_2H-2iSK9SXHI',
  PSUV:  '1YW_MHogZpf9w4t0MGMiBNwPVO9L0TikLB1ME0PTZh18',
  PUTH:  '15yozB4bUZqEGkKuXKp3t32wOlTjk-3VfkyeNbeEZcrs',
  PLPN1: '1r8_v5OQtLlQvjilNJ_UqNvX8vuj-4ooNwHHTZQi4b8c',
  PSSK:  '18EpoJD9QyEeT3NF9Nwk0cn6xyRnXDudVXsO-HAcLUho',
  PCPN:  '1IMeoKPRZCiFhxRmk-udDxrv6N8nbEnf0C1MaqHJr1rI',
  PUBN:  '102o5OA4ycqDz0cRNNMHKhu1LtKUqYT_8LiLR8-VwXAY',
  KBKJ:  '1gwadwrNxXDqhr53gJW7FWqZKtLVph2suLyuK5QRayus',
  PSNK:  '1lteakhBG02GdgdYeL4LjJKql6uU_o9zgSfwouWzS7YU',
  PPRP:  '1jW922u_KbWO_Fl57rxYgLE-PVek3Ytf7gFBbhBSoem4',
  PMDH:  '1C_6Jf-QU96ChRf9zETSaYTcAN8lH5ZjygIZ6gI6YlMY',
  PLPN2: '1MmHYw7Sib7BvpsYzFAIZvmSlGYtWkgqyLiMpyTN1mdQ',
  PKPP:  '10iXenl1dSWyXgY6fD5-O3x7FzzXXrgV_vA6O3mxvbh8',
  PKAN:  '1gDW547a8oKngt3Hb8S1LOzyDSwqqfGltDqaIoJIOQK4',
  PKRT:  '1jVh_oUN9HhVY6Wz-D7lByjG6l2CZza1sbRrSWH3fE9s',
  PPAT:  '1b_6kM520q7tfWJXS5EaH5sIn4YfzBSWh8F_X1U6UeVI',
};
const _prof = PROFILES[PROFILE_KEY];
if (!_prof) {
  const swapped = BU_ODOO_PREFIX[PROFILE_KEY] && PROFILES[TARGET_BU_CODE];
  throw new Error(
    `Unknown profile "${PROFILE_KEY}". Valid: ${Object.keys(PROFILES).join(', ')}` +
    (swapped ? `\n(profile and BU_CODE may be swapped — usage is <profile> <BU_CODE>)` : '')
  );
}
if (!BU_ODOO_PREFIX[TARGET_BU_CODE]) throw new Error(`Unknown BU "${TARGET_BU_CODE}". Valid: ${Object.keys(BU_ODOO_PREFIX).join(', ')}`);
const TARGET_BUYER   = _prof.buyer;
const HEADLESS       = process.argv.includes('--headless');
const GENERATE       = process.argv.includes('--generate');
const TEST_MODE      = process.argv.includes('--test');
const DOWNLOAD_PATH   = `${process.env.USERPROFILE}\\Downloads`;
const GSHEET_REF_ID  = '1HaJt0f0qVnY2vFs193ZVXdI5xhenKMTYkr-TZcj3Rzo'; // vendor + min order reference
const GSHEET_REF_GID = '139595673'; // tab: data_view
const GSHEET_LOG_ID  = BU_LOG_SHEETS[TARGET_BU_CODE] ?? (() => { throw new Error(`No log sheet configured for BU "${TARGET_BU_CODE}"`); })();
const GSHEET_LOG_TAB      = _prof.logTab;
const CONFIG              = { profileKey: PROFILE_KEY, bu: TARGET_BU_CODE, buyer: TARGET_BUYER, logTab: GSHEET_LOG_TAB };
const GSHEET_EXEC_TAB     = 'Execute Log';
const GSHEETS_TOKEN_FILE  = join(__dir, '.gsheets-token.json');
// Appended (2nd Tier Vendor) added as column O (2026-07-03) — appended at the
// end, not inserted mid-row, so historical rows' existing columns don't shift.
const EXEC_LOG_HEADERS    = ['Run ID','Date','Time','Status','Exported Rows','Appended Rows','Skipped (Duplicates)','Rejected (Total)','Rejected (Vendor)','Rejected (Min Order)','Rejected Items','Rejection Reasons','Stopped At','Error','Appended (2nd Tier Vendor)'];

// Column name overrides: source header → dest header (when names differ)
const COL_NAME_OVERRIDES = {
  'cancel reason': 'cancel',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// "2nd tier Vendor" cell can hold multiple vendors, "|"-separated, each as
// "<code> <name>" (e.g. "0000000308 บริษัท... - BDF | 0000000918 บริษัท... - 3M").
// Entries without a leading numeric code are matched as name-only.
function parseTier2Vendors(raw) {
  return (raw || '')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const m = entry.match(/^(\d+)\s+(.*)$/);
      return m ? { code: m[1], name: m[2].trim() } : { code: '', name: entry };
    });
}

function parseCSVLine(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      cells.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

async function fetchGSheetCSV() {
  const { get: httpsGet } = await import('https');
  const startUrl = `https://docs.google.com/spreadsheets/d/${GSHEET_REF_ID}/export?format=csv&gid=${GSHEET_REF_GID}`;

  function fetchUrl(u, hops = 0) {
    return new Promise((resolve, reject) => {
      if (hops > 5) return reject(new Error('Too many redirects fetching GSheet'));
      const req = httpsGet(u, { timeout: 30000 }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchUrl(res.headers.location, hops + 1));
          return;
        }
        if (res.statusCode !== 200) return reject(new Error(`GSheet HTTP ${res.statusCode}`));
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('GSheet fetch timed out after 30s')));
      req.on('error', reject);
    });
  }

  const csv = await fetchUrl(startUrl);
  const lines = csv.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
    return obj;
  });
}

async function writeExecuteLog({ runId, status, exportedRows, appendedRows, skippedRows, rejectedRows, rejectedVendor, rejectedMinOrder, rejectedItems, rejectionReasons, stoppedAt, error, appendedTier2Vendor }) {
  try {
    const sheets = await getSheetClient();

    const d = new Date(), p = v => String(v).padStart(2, '0');
    await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_LOG_ID,
      range: `'${GSHEET_EXEC_TAB}'!A:O`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        runId,
        `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`,
        `${p(d.getHours())}:${p(d.getMinutes())}`,
        status,
        exportedRows    ?? '',
        appendedRows    ?? '',
        skippedRows     ?? '',
        rejectedRows    ?? '',
        rejectedVendor  ?? '',
        rejectedMinOrder ?? '',
        rejectedItems    ?? '',
        rejectionReasons ?? '',
        stoppedAt        ?? '',
        error            ?? '',
        appendedTier2Vendor ?? '',
      ]]},
    });
    log(`Execute log → "${status}" written to "${GSHEET_EXEC_TAB}" tab`);
  } catch (e) {
    log(`WARNING: Could not write execute log: ${e.message}`);
  }
}

async function getSheetClient() {
  const { google } = await import('googleapis');
  const { GDRIVE_CLIENT_ID: clientId, GDRIVE_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret)
    throw new Error('GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET not set in .env');

  const auth = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/callback');

  if (existsSync(GSHEETS_TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(readFileSync(GSHEETS_TOKEN_FILE, 'utf8')));
    return google.sheets({ version: 'v4', auth });
  }

  // First run only: open browser for OAuth
  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  try { execSync(`start "" "${authUrl}"`, { stdio: 'ignore' }); } catch {}
  log(`\nOpen this URL to authorize Google Sheets access:\n${authUrl}\n`);

  const { createServer } = await import('http');
  const code = await new Promise(resolve => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost:3000');
      const c = u.searchParams.get('code');
      if (c) { res.end('<h2>Done! You can close this tab.</h2>'); server.close(); resolve(c); }
      else res.end('Waiting...');
    }).listen(3000);
    log('Waiting for OAuth callback on http://localhost:3000/callback ...');
  });

  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  writeFileSync(GSHEETS_TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  log('Google Sheets token saved → ' + GSHEETS_TOKEN_FILE);
  return google.sheets({ version: 'v4', auth });
}

// Sheets API's values.append (insertDataOption: INSERT_ROWS) inherits cell
// formatting from the row directly above the insertion point. On a fresh
// per-BU log tab (headers only, no data rows yet), that row IS the header —
// so the first append copies header formatting (bold, background, etc.) onto
// real data rows. Resets appended rows to font "Prompt" (Thai-safe) and
// re-applies explicit date formatting to Request Date / Required Date, since
// the blanket format reset would otherwise also strip USER_ENTERED's
// auto-detected date format. tabName must match a sheets.properties.title;
// headers is the destination tab's header row (to locate the date columns).
async function clearAppendedFormatting(sheets, tabName, updatedRange, headers = []) {
  const m = /![A-Z]+(\d+):[A-Z]+(\d+)/.exec(updatedRange || '');
  if (!m) return;
  const [, startRow, endRow] = m;
  const startRowIndex = Number(startRow) - 1;
  const endRowIndex   = Number(endRow);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: GSHEET_LOG_ID, fields: 'sheets.properties' });
  const sheetId = meta.data.sheets.find(s => s.properties.title === tabName)?.properties.sheetId;
  if (sheetId === undefined) return;

  const requests = [{
    repeatCell: {
      range: { sheetId, startRowIndex, endRowIndex },
      cell: { userEnteredFormat: { textFormat: { fontFamily: 'Prompt' } } },
      fields: 'userEnteredFormat',
    },
  }];

  for (const colName of ['date', 'request date', 'required date']) {
    const colIdx = headers.findIndex(h => h?.toString().trim().toLowerCase() === colName);
    if (colIdx < 0) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex, endRowIndex, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd-mm-yyyy' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  for (const colName of ['tax incl.', 'unit price']) {
    const colIdx = headers.findIndex(h => h?.toString().trim().toLowerCase() === colName);
    if (colIdx < 0) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex, endRowIndex, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: GSHEET_LOG_ID,
    requestBody: { requests },
  });
}

// Formatting is cosmetic — it must never fail the run. The append has already
// landed by this point, so letting a formatting error propagate would make
// checkpoint D's withRetry re-run appendToLog, see its own freshly-appended
// rows as duplicates, and EarlyExit "all duplicates" — silently skipping
// generation for PRs that were in fact appended.
async function tryFixFormatting(sheets, appendRes, headers) {
  try {
    await clearAppendedFormatting(sheets, GSHEET_LOG_TAB, appendRes.data.updates?.updatedRange, headers);
  } catch (e) {
    log(`WARNING: Could not clear appended-row formatting: ${e.message}`);
  }
}

function today() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// Resolve BU code from a Company cell like "[PLPN:00059] Princ Lampang ..."
// Falls back to the letters inside brackets if the full prefix isn't in the map.
function buFromCompany(company) {
  const prefix = company.match(/^\[[A-Z]+:\d+\]/)?.[0];
  return (prefix && PREFIX_TO_BU[prefix]) || company.match(/\[([A-Z]+):/)?.[1] || '';
}

// ─── STEP 1: LAUNCH & CONNECT ────────────────────────────────────────────────
async function connectAndNavigate() {
  log('Launching Chrome...');
  const browser  = await chromium.launch({ headless: HEADLESS, channel: 'chrome' });
  const context  = await browser.newContext();
  const page     = await context.newPage();
  return { browser, context, page };
}

// ─── STEP 2: SELECT DATABASE ──────────────────────────────────────────────────
async function selectDatabase(page) {
  log('Navigating to database selector...');
  await page.goto(DB_SELECTOR_URL);
  await page.waitForLoadState('networkidle');

  // Click the most recent princ-smarterp-prod-base-* database
  await page.click('a[href*="princ-smarterp-prod-base-"]');
  await page.waitForLoadState('load');
  log(`Database selected, URL: ${page.url()}`);
}

// ─── STEP 3: LOGIN ────────────────────────────────────────────────────────────
async function login(page) {
  if (!page.url().includes('/login')) {
    log('Already logged in — skipping login');
    return;
  }
  log('Logging in...');
  await page.fill('input[name="login"]', USERNAME);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  log('Logged in');
}

// ─── STEP 4: SWITCH BU ────────────────────────────────────────────────────────
async function switchBU(page) {
  log(`Switching BU to ${TARGET_BU_CODE}...`);

  // Wait for navbar to be ready
  await page.waitForSelector('.o_main_navbar', { timeout: 30000 });

  // Wait up to 5s for company switcher to attach — isVisible() is too strict and
  // returns false while the element is in DOM but not yet painted
  let switcherFound = false;
  try {
    await page.waitForSelector('.o_switch_company_menu', { timeout: 5000, state: 'attached' });
    switcherFound = true;
  } catch {}

  if (!switcherFound) {
    log('Company switcher not present — single-company mode, proceeding as-is');
    return;
  }

  // Open company switcher
  await page.click('.o_switch_company_menu button');
  await page.waitForTimeout(1000);

  // Find company with matching code
  const companies = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.o_switch_company_menu [data-company-id]')).map(el => ({
      id: el.getAttribute('data-company-id'),
      label: el.querySelector('.company_label')?.textContent?.trim() || '',
    }))
  );

  const odooPrefix = BU_ODOO_PREFIX[TARGET_BU_CODE];
  if (!odooPrefix) throw new Error(`Unknown BU "${TARGET_BU_CODE}". Valid: ${Object.keys(BU_ODOO_PREFIX).join(', ')}`);
  const target = companies.find(c => c.label.startsWith(odooPrefix));
  if (!target) throw new Error(`BU "${TARGET_BU_CODE}" not found in company list`);

  log(`Found BU: ${target.label}`);
  await page.click(`[data-company-id="${target.id}"] .log_into`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  log(`Switched to ${TARGET_BU_CODE}`);
}

// ─── STEP 5: NAVIGATE TO GENERATE PR TO PO ───────────────────────────────────
async function navigateToPRtoPO(page) {
  log('Waiting for navbar to be ready...');
  await page.waitForSelector('.o_navbar_apps_menu button', { timeout: 30000 });
  await page.waitForTimeout(1000);
  log('Opening 9-dot home menu...');
  await page.click('.o_navbar_apps_menu button');
  await page.waitForTimeout(1000);

  log('Clicking Purchase app...');
  await page.click('a.o_app[href*="menu_id=340"]');
  await page.waitForTimeout(3000);

  log('Clicking Operations → Generate PR to PO...');
  await page.locator('.o_menu_sections button').filter({ hasText: 'Operations' }).click();
  await page.waitForTimeout(800);
  await page.locator('.dropdown-menu a, .dropdown-item').filter({ hasText: 'Generate PR to PO' }).first().click();
  await page.waitForTimeout(3000);
  log('On Generate PR to PO page');
}

// ─── STEP 6: REMOVE DEFAULT FILTER ───────────────────────────────────────────
async function removeFilter(page) {
  await page.waitForTimeout(1500);
  const facet = page.locator('.o_searchview_facet').filter({ hasText: 'Generate PR to PO' });
  if (await facet.count() > 0) {
    log('Removing "Generate PR to PO" filter...');
    await facet.locator('.o_facet_remove').click();
    await page.waitForTimeout(1500);
    log('Filter removed');
  } else {
    log('No "Generate PR to PO" filter found — skipping');
  }
}

// ─── STEP 7: GROUP BY BUYER ───────────────────────────────────────────────────
async function groupByBuyer(page) {
  log('Adding Group By: Buyer...');
  await page.click('.o_searchview_dropdown_toggler');
  await page.waitForTimeout(800);
  await page.selectOption('.o_add_custom_group_menu', 'buyer_id');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  log('Grouped by Buyer');
}

// ─── STEP 8: CLICK SUPPLY_BUYER ───────────────────────────────────────────────
async function clickSupplyBuyer(page) {
  log(`Clicking ${TARGET_BUYER} group...`);
  await page.waitForTimeout(1500);

  if (await page.locator('.o_group_header').count() === 0) {
    log('No PR groups found — list is empty');
    return false;
  }

  const target = page.locator('.o_group_header').filter({ hasText: TARGET_BUYER });
  if (await target.count() === 0) {
    log(`${TARGET_BUYER} group not found — no pending PRs`);
    return false;
  }

  await target.first().click();
  await page.waitForTimeout(2000);
  log(`${TARGET_BUYER} expanded`);
  return true;
}

// ─── STEP 9: EXPORT XLSX ─────────────────────────────────────────────────────
async function exportXLSX(page) {
  log('Selecting all items...');
  await page.locator('thead .o_list_record_selector input[type="checkbox"]').click();
  await page.waitForTimeout(500);

  log('Opening Action → Export...');
  await page.click('.o_cp_action_menus button');
  await page.waitForTimeout(500);
  await page.click('.o_cp_action_menus .dropdown-item:has-text("Export")');
  await page.waitForTimeout(1500);

  log('Selecting XLSX format...');
  await page.click('#o_radioxlsx');
  await page.waitForTimeout(300);

  // Intercept the export response via network route
  const filePath = `${DOWNLOAD_PATH}\\odoo_export_temp.xlsx`;
  const ROUTE_URL = '**/web/export/xlsx';
  let captured = false;

  await page.route(ROUTE_URL, async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    writeFileSync(filePath, body);
    captured = true;
    log(`Captured export response (${body.length} bytes)`);
    // Respond with inline HTML so Chrome doesn't trigger a file download
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' });
  });

  try {
    await page.click('.o_export_data_dialog .o_select_button');

    // Wait for route to capture the file
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (captured) break;
    }
    if (!captured) throw new Error('Export request not captured — check network route');
  } finally {
    // Unregister so retries don't stack duplicate handlers
    await page.unroute(ROUTE_URL).catch(() => {});
  }

  log(`Saved export to: ${filePath}`);

  // Close the export dialog if still open
  const dialog = page.locator('.o_export_data_dialog');
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    log('Export dialog closed');
  }

  return { filePath };
}

// ─── STEP 10: GET NEW ROWS (dedup only — no write yet) ───────────────────────
async function appendToLog(exportPath) {
  log('Reading export file...');
  const srcWb      = XLSX.readFile(exportPath);
  const srcSheet   = srcWb.Sheets[srcWb.SheetNames[0]];
  const srcAllRows = XLSX.utils.sheet_to_json(srcSheet, { header: 1 });
  const srcHeaders = srcAllRows[0];

  // Filter out group summary rows (e.g. "SUPPLY_BUYER (1)")
  const srcData = srcAllRows.slice(1).filter(r => !/ \(\d+\)$/.test(r[0]?.toString() || ''));
  log(`Real data rows: ${srcData.length}`);

  log('Reading log sheet...');
  const sheets  = await getSheetClient();
  const res     = await sheets.spreadsheets.values.get({
    spreadsheetId: GSHEET_LOG_ID,
    range: GSHEET_LOG_TAB,
  });
  const dstRows    = res.data.values || [];
  const dstHeaders = dstRows[0] || [];

  // Build column mapping: source col B→O → destination col index
  const colMap = {};
  srcHeaders.slice(1, 15).forEach(srcCol => {
    const key = COL_NAME_OVERRIDES[srcCol?.toString().trim().toLowerCase()] || srcCol?.toString().trim().toLowerCase();
    colMap[srcCol] = dstHeaders.findIndex(h => h?.toString().trim().toLowerCase() === key);
  });

  const dateIdx  = 0;
  const todayStr = today();

  // Build set of existing PR+Product keys to prevent duplicates (keyed per line, not per PR)
  const prNumIdx   = dstHeaders.findIndex(h => h?.toString().toLowerCase().includes('purchase number'));
  const productIdx = dstHeaders.findIndex(h => h?.toString().trim().toLowerCase() === 'product');
  const qtyIdx     = dstHeaders.findIndex(h => h?.toString().trim().toLowerCase() === 'quantity');
  const unitPrIdx  = dstHeaders.findIndex(h => h?.toString().trim().toLowerCase() === 'unit price');

  const normNum = v => {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? String(v).trim() : String(n);
  };
  const normStr = v => String(v ?? '').trim();

  const existingKeys = new Set(dstRows.slice(1).map(r => {
    const pr = r[prNumIdx];
    return pr ? `${normStr(pr)}|${normStr(r[productIdx])}|${normNum(r[qtyIdx])}|${normNum(r[unitPrIdx])}` : null;
  }).filter(Boolean));

  const srcPrIdx        = srcHeaders.indexOf('Purchase Number');
  const srcProductIdx   = srcHeaders.indexOf('Product');
  const srcQtyIdx       = srcHeaders.indexOf('Quantity');
  const srcUnitPriceIdx = srcHeaders.indexOf('Unit Price');

  const newRows = [];
  srcData.forEach(srcRow => {
    const rowKey = `${normStr(srcRow[srcPrIdx])}|${normStr(srcRow[srcProductIdx])}|${normNum(srcRow[srcQtyIdx])}|${normNum(srcRow[srcUnitPriceIdx])}`;
    if (existingKeys.has(rowKey)) {
      log(`Skipping duplicate row: ${rowKey}`);
      return;
    }
    existingKeys.add(rowKey);
    const newRow = new Array(dstHeaders.length).fill('');
    newRow[dateIdx] = todayStr;
    srcHeaders.slice(1, 15).forEach((srcCol, i) => {
      const dstIdx = colMap[srcCol];
      if (dstIdx >= 0 && srcRow[i + 1] !== undefined) newRow[dstIdx] = srcRow[i + 1] ?? '';
    });
    newRows.push(newRow);
  });

  log(`New rows after dedup: ${newRows.length} (${srcData.length - newRows.length} duplicates skipped)`);
  return { newRows, headers: dstHeaders, skipped: srcData.length - newRows.length, exported: srcData.length };
}

// ─── STEP 11: VALIDATE (VENDOR + MIN ORDER) THEN APPEND ─────────────────────
async function validateAndAppend(newRows, headers) {
  if (newRows.length === 0) {
    return { appended: 0, total: 0, vendor: 0, minOrder: 0, items: '', reasons: '', validationSkipped: false, passingPRNumbers: [], tier2Count: 0 };
  }

  log('Fetching vendor & minimum order reference from Google Sheet...');
  let refRows;
  try {
    refRows = await fetchGSheetCSV();
  } catch (e) {
    log(`WARNING: Could not fetch reference GSheet (${e.message}) — appending all rows without validation`);
    const sheets = await getSheetClient();
    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_LOG_ID, range: GSHEET_LOG_TAB,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
    await tryFixFormatting(sheets, appendRes, headers);
    // passingPRNumbers stays empty — unvalidated rows must never be auto-generated
    return { appended: newRows.length, total: 0, vendor: 0, minOrder: 0, items: '', reasons: '', validationSkipped: true, passingPRNumbers: [], tier2Count: 0 };
  }
  log(`Reference sheet loaded: ${refRows.length} rows`);

  // Build lookup map: `${bu}|${itemCode}` → ref rows[]
  const refMap = new Map();
  for (const r of refRows) {
    const key = `${r.bu}|${r.order_item_code}`;
    if (!refMap.has(key)) refMap.set(key, []);
    refMap.get(key).push(r);
  }

  // Column indices
  const productIdx = headers.indexOf('Product');
  const taxIdx     = headers.indexOf('Tax incl.');
  const prIdx      = headers.findIndex(h => h?.toString().toLowerCase().includes('purchase number'));
  const companyIdx = headers.indexOf('Company');
  const vendorIdx  = headers.findIndex(h => h?.toString().toLowerCase().includes('vendor'));

  // Group new rows by PR number
  const prGroups = new Map();
  for (const row of newRows) {
    const prNum = row[prIdx] || '';
    if (!prGroups.has(prNum)) prGroups.set(prNum, []);
    prGroups.get(prNum).push(row);
  }

  const passingRows      = [];
  const passingPRNumbers = [];
  let vendorFailCount    = 0;
  let minOrderFailCount  = 0;
  const rejectedItems    = [];
  const rejectedReasons  = [];

  const tier2PassPRNumbers = [];

  for (const [prNum, rows] of prGroups) {
    let prRejected     = false;
    let rejReason      = '';
    let rejTag         = '';
    let prMatchedTier2 = false;

    // ── 1. Vendor check (per row — wrong vendor rejects whole PR) ─────────────
    outer:
    for (const row of rows) {
      const productRaw = (row[productIdx] || '').toString();
      const company    = (row[companyIdx] || '').toString();
      const vendorRaw  = vendorIdx >= 0 ? (row[vendorIdx] || '').toString().trim() : '';
      const buCode     = buFromCompany(company);
      const itemCode   = productRaw.match(/^\[(\d+)\]/)?.[1];
      if (!itemCode) continue;

      const refs = refMap.get(`${buCode}|${itemCode}`);
      if (!refs) continue;

      const logVendorCode = vendorRaw.match(/^\(([^)]+)\)/)?.[1]?.trim() || '';
      const logVendorName = vendorRaw.replace(/^\([^)]+\)\s*/, '').trim().toLowerCase();

      // Multiple ref rows = alternative approved vendors — pass if ANY matches.
      // A ref with blank code and name means any vendor is OK.
      // 2nd tier Vendor is a "|"-separated fallback list: pass if the log
      // vendor's code or name matches ANY entry in it. Track whether a pass
      // only happened via 2nd tier so the run can report it separately —
      // 2nd tier vendors are prior manual approvals, not the primary criteria.
      let vendorOk = false;
      for (const ref of refs) {
        const refVendorCode = ref['Vendor Code'].trim();
        const refVendorName = ref['Vendor Name'].trim();
        const tier2Vendors  = parseTier2Vendors(ref['2nd tier Vendor']);
        const anyVendorOk   = !refVendorCode && !refVendorName;
        const tier1Ok        = (refVendorCode && logVendorCode === refVendorCode) || (refVendorName && logVendorName === refVendorName.toLowerCase());
        const tier2Ok        = tier2Vendors.some(v => (v.code && logVendorCode === v.code) || (v.name && logVendorName === v.name.toLowerCase()));
        if (anyVendorOk || tier1Ok || tier2Ok) {
          vendorOk = true;
          if (tier2Ok && !anyVendorOk && !tier1Ok) prMatchedTier2 = true;
          break;
        }
      }

      if (!vendorOk) {
        const expected = refs
          .map(r => {
            const tier2 = parseTier2Vendors(r['2nd tier Vendor']);
            const tier2Str = tier2.length ? ` or 2nd tier ${tier2.map(v => `"(${v.code}) ${v.name}"`).join(' or ')}` : '';
            return `"(${r['Vendor Code'].trim()}) ${r['Vendor Name'].trim()}"${tier2Str}`;
          })
          .join(' or ');
        prRejected = true;
        rejTag     = 'vendor';
        rejReason  = `wrong vendor on [${itemCode}]: got "${vendorRaw}", expected ${expected}`;
        log(`REJECTED PR ${prNum}: ${rejReason}`);
        break outer;
      }
    }

    // ── 2. Minimum order check (sum Tax incl. per vendor within this PR) ──────
    if (!prRejected) {
      // vendorKey → { total, minRequired } — every line counts toward the vendor's
      // order total; only items with a ref entry contribute a minimum requirement
      const vendorTotals = new Map();
      for (const row of rows) {
        const productRaw = (row[productIdx] || '').toString();
        const company    = (row[companyIdx] || '').toString();
        const vendorRaw  = vendorIdx >= 0 ? (row[vendorIdx] || '').toString().trim() : '';
        const taxIncl    = parseFloat(String(row[taxIdx] ?? '').replace(/,/g, '')) || 0;
        const buCode     = buFromCompany(company);
        const itemCode   = productRaw.match(/^\[(\d+)\]/)?.[1];

        if (!vendorTotals.has(vendorRaw)) vendorTotals.set(vendorRaw, { total: 0, minRequired: 0 });
        const vt = vendorTotals.get(vendorRaw);
        vt.total += taxIncl;

        const refs = itemCode ? refMap.get(`${buCode}|${itemCode}`) : null;
        if (!refs) continue;
        vt.minRequired = Math.max(vt.minRequired, ...refs.map(r => parseFloat(r['Minimum Order']) || 0));
      }

      for (const [vendor, { total, minRequired }] of vendorTotals) {
        if (minRequired > 0 && total < minRequired) {
          prRejected = true;
          rejTag     = 'min order';
          rejReason  = `${vendor} total ${total.toLocaleString()} < ${minRequired.toLocaleString()} minimum order`;
          log(`REJECTED PR ${prNum}: ${rejReason}`);
          break;
        }
      }
    }

    if (prRejected) {
      if (rejTag === 'vendor')    vendorFailCount++;
      if (rejTag === 'min order') minOrderFailCount++;
      rejectedItems.push(`${prNum}(${rejTag})`);
      rejectedReasons.push(`${prNum}: ${rejReason}`);
    } else {
      passingRows.push(...rows);
      passingPRNumbers.push(prNum);
      if (prMatchedTier2) tier2PassPRNumbers.push(prNum);
    }
  }

  // Append only passing rows
  if (passingRows.length > 0) {
    const sheets = await getSheetClient();
    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_LOG_ID, range: GSHEET_LOG_TAB,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: passingRows },
    });
    await tryFixFormatting(sheets, appendRes, headers);
  }

  const totalRejected = rejectedItems.length;
  log(`Appended ${passingRows.length} row(s). Rejected ${totalRejected} PR(s).`);
  if (totalRejected === 0) log('All PRs passed vendor and minimum order checks');

  if (tier2PassPRNumbers.length > 0) log(`Passed via 2nd tier vendor: ${tier2PassPRNumbers.join(', ')}`);

  return {
    appended:  passingRows.length,
    total:     totalRejected,
    vendor:    vendorFailCount,
    minOrder:  minOrderFailCount,
    items:     rejectedItems.join(', '),
    reasons:   rejectedReasons.join('; '),
    validationSkipped: false,
    passingPRNumbers,
    tier2Count: tier2PassPRNumbers.length,
    tier2PassPRNumbers,
  };
}

// ─── STEP 12: CLEANUP ────────────────────────────────────────────────────────
function cleanup({ filePath }) {
  try {
    unlinkSync(filePath);
    log(`Deleted export file: ${filePath}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`WARNING: Could not delete export file: ${e.message}`);
  }
}

// ─── STEP 13: GENERATE TO PO FOR PASSING PRs (--generate only) ──────────────
// Deliberately NOT wrapped in withRetry (see header comment) — one attempt,
// no auto-retry, so a mid-flow failure can't cause a re-click on real POs.
async function generateApprovedPOs(page, prNumbers) {
  if (prNumbers.length === 0) {
    log('No PRs passed validation — nothing to generate');
    return { attempted: false, executed: false, matched: [] };
  }

  step('13/13 generateApprovedPOs');
  log(`Generating PO for ${prNumbers.length} passing PR(s): ${prNumbers.join(', ')}`);

  // exportXLSX (step 9) left the header "select all" checkbox checked —
  // clear it before selecting only the passing PR rows.
  await resetSelection(page);

  const matched  = await selectPRRows(page, prNumbers, TARGET_BUYER, log);
  const executed = await executeOdooAction(page, 'approve', { testMode: TEST_MODE, log });
  return { attempted: true, executed, matched };
}

// ─── OPERATOR ─────────────────────────────────────────────────────────────────
const MAX_RETRIES   = 3;
const RETRY_BACKOFF = 3000;

const RUN_ID = (() => {
  const n = new Date(), p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
})();

let currentStep = '?';
function step(s) { currentStep = s; log(`── ${s}`); }

class EarlyExit extends Error {
  constructor(reason, atStep) {
    super(reason);
    this.isEarlyExit = true;
    this.failedStep  = atStep;
  }
}

// Retries fn up to MAX_RETRIES with linear backoff. fn receives the attempt
// number (1-based) so it can recover state (e.g. re-navigate) on retries.
async function withRetry(name, fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err.isEarlyExit) throw err;
      const isLast = attempt === MAX_RETRIES;
      log(`[${name}] FAILED at ${currentStep} (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
      if (isLast) {
        err.failedStep = currentStep;
        throw err;
      }
      await new Promise(r => setTimeout(r, RETRY_BACKOFF * attempt));
    }
  }
}

async function checkpointA() {
  return withRetry('A: browser + DB', async () => {
    step('1/12 connectAndNavigate'); const conn = await connectAndNavigate();
    step('2/12 selectDatabase');
    try {
      await selectDatabase(conn.page);
    } catch (err) {
      await conn.browser.close().catch(() => {}); // don't leak browsers across retries
      throw err;
    }
    return conn;
  });
}

async function checkpointB(page) {
  return withRetry('B: login + BU', async () => {
    step('3/12 login');            await login(page);
    step('4/12 switchBU');         await switchBU(page);
    step('5/12 navigateToPRtoPO'); await navigateToPRtoPO(page);
  });
}

async function checkpointC(page) {
  return withRetry('C: filter + export', async (attempt) => {
    if (attempt > 1) {
      step('5↺ navigateToPRtoPO (recovery)');
      await navigateToPRtoPO(page);
    }
    step('6/12 removeFilter');     await removeFilter(page);
    step('7/12 groupByBuyer');     await groupByBuyer(page);
    step('8/12 clickSupplyBuyer');
    const hasData = await clickSupplyBuyer(page);
    if (!hasData) {
      throw new EarlyExit(`No ${CONFIG.buyer} PRs found — nothing to process`, '8/12 clickSupplyBuyer');
    }
    step('9/12 exportXLSX');
    const exportPaths = await exportXLSX(page);
    if (!exportPaths?.filePath || !existsSync(exportPaths.filePath)) throw new Error('Export file not created — zero rows or export failed');
    return exportPaths;
  });
}

async function checkpointD(exportPaths, runStats) {
  return withRetry('D: process + append', async () => {
    step('10/12 appendToLog');
    const { newRows, headers, skipped, exported } = await appendToLog(exportPaths.filePath);
    runStats.exportedRows = exported;
    runStats.skippedRows  = skipped;

    if (newRows.length === 0) {
      cleanup(exportPaths);
      throw new EarlyExit('All rows were duplicates — nothing new to process', '10/12 appendToLog');
    }

    step('11/12 validateAndAppend');
    const rej = await validateAndAppend(newRows, headers);
    runStats.appendedRows     = rej.appended;
    runStats.rejectedRows     = rej.total;
    runStats.rejectedVendor   = rej.vendor;
    runStats.rejectedMinOrder = rej.minOrder;
    runStats.rejectedItems    = rej.items;
    runStats.rejectionReasons = rej.reasons;
    runStats.passingPRNumbers = rej.passingPRNumbers;
    runStats.appendedTier2Vendor = rej.tier2Count;
    runStats.tier2PassPRNumbers  = rej.tier2PassPRNumbers || [];
    if (rej.validationSkipped) {
      runStats.status = 'WARN';
      runStats.error  = 'Reference sheet unreachable — rows appended WITHOUT vendor/min-order validation';
    }

    step('12/12 cleanup');
    cleanup(exportPaths);
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[OPERATOR] PR2PO starting — RUN_ID: ${RUN_ID} | Profile: ${CONFIG.profileKey.toUpperCase()} | BU: ${CONFIG.bu}`);
  console.log(`[OPERATOR] Log tab: ${CONFIG.logTab}`);

  const runStats = {
    runId: RUN_ID, status: 'SUCCESS',
    exportedRows: null, appendedRows: null, skippedRows: null,
    rejectedRows: null, rejectedVendor: null, rejectedMinOrder: null, rejectedItems: null, rejectionReasons: null,
    appendedTier2Vendor: 0, tier2PassPRNumbers: [],
    passingPRNumbers: [], generateAttempted: false, generateExecuted: false, generateMatched: [], generateError: null,
    stoppedAt: null, error: null,
  };

  let conn;
  try {
    conn = await checkpointA();
    await checkpointB(conn.page);
    const exportPaths = await checkpointC(conn.page);
    await checkpointD(exportPaths, runStats);

    if (GENERATE) {
      try {
        const gen = await generateApprovedPOs(conn.page, runStats.passingPRNumbers || []);
        runStats.generateAttempted = gen.attempted;
        runStats.generateExecuted  = gen.executed;
        runStats.generateMatched   = gen.matched;
      } catch (err) {
        // No retry here on purpose — a re-attempt could re-click an already-
        // generated batch. Report and stop; does not overwrite an existing
        // WARN status from validation.
        runStats.generateAttempted = true;
        runStats.generateError     = err.message;
        if (runStats.status === 'SUCCESS') runStats.status = 'FAILED';
        runStats.stoppedAt = '13/13 generateApprovedPOs';
        console.error(`\n❌ Generate to PO failed: ${err.message}`);
      }
    }

    console.log(`\n[OPERATOR] RUN_ID: ${RUN_ID} — COMPLETED ${runStats.status === 'WARN' ? 'WITH WARNINGS' : runStats.status === 'FAILED' ? 'WITH GENERATE FAILURE' : 'SUCCESSFULLY'}`);
    if (runStats.appendedTier2Vendor > 0) {
      console.log(`[VENDOR TIER] Passed via 2nd tier (previously user-approved) vendor: ${runStats.tier2PassPRNumbers.join(', ')}`);
    }
    if (GENERATE) {
      const genResult = runStats.generateError ? 'FAILED' : !runStats.generateAttempted ? 'SKIPPED (none passing)' : TEST_MODE ? 'DRY-RUN' : 'EXECUTED';
      console.log(`[GENERATE] Result: ${genResult}${runStats.generateError ? ` — ${runStats.generateError}` : ''}`);
      for (const { prNumber, rowTexts } of runStats.generateMatched) console.log(`  PR [${prNumber}] — ${rowTexts.length} line(s)`);
    }
  } catch (err) {
    runStats.status    = err.isEarlyExit ? 'WARN' : 'FAILED';
    runStats.stoppedAt = err.failedStep || '';
    runStats.error     = err.message;
    const print = err.isEarlyExit ? console.log : console.error;
    print(`\n[OPERATOR] RUN_ID: ${RUN_ID} — ${runStats.status}: ${err.message}`);
  } finally {
    await Promise.all([
      conn?.browser ? conn.browser.close().catch(() => {}) : Promise.resolve(),
      writeExecuteLog(runStats),
    ]);
    if (runStats.status === 'FAILED') process.exit(1);
  }
})();
