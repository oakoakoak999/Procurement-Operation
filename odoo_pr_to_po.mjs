/**
 * ODOO PR → PO Workflow Automation
 * BU: PSV | Credentials loaded from .env
 * Exports Generate PR to PO (SUPPLY_BUYER) and appends to Log file
 */

import { chromium } from 'playwright';
import XLSX from 'xlsx';
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

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
  throw new Error('Usage: node odoo_pr_to_po.mjs <profile> <BU_CODE> [--headless]\nProfiles: supply | medicine');

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
const _prof = PROFILES[PROFILE_KEY];
if (!_prof) throw new Error(`Unknown profile "${PROFILE_KEY}". Valid: ${Object.keys(PROFILES).join(', ')}`);
const TARGET_BUYER   = _prof.buyer;
const HEADLESS       = process.argv.includes('--headless');
const DOWNLOAD_PATH   = `${process.env.USERPROFILE}\\Downloads`;
const GSHEET_REF_ID  = '1HaJt0f0qVnY2vFs193ZVXdI5xhenKMTYkr-TZcj3Rzo'; // vendor + min order reference
const GSHEET_REF_GID = '139595673'; // tab: data_view
const GSHEET_LOG_ID  = '13-aAvDWJ4DxOGyZLgCOoPrwhy6xSVGiEER_v63a7jrc'; // log sheet (owned by thanapol.ph@princgroup.com)
const GSHEET_LOG_TAB      = _prof.logTab;
const CONFIG              = { profileKey: PROFILE_KEY, bu: TARGET_BU_CODE, buyer: TARGET_BUYER, logTab: GSHEET_LOG_TAB };
const GSHEET_EXEC_TAB     = 'Execute Log';
const GSHEETS_TOKEN_FILE  = join(__dir, '.gsheets-token.json');
const EXEC_LOG_HEADERS    = ['Run ID','Date','Time','Status','Exported Rows','Appended Rows','Skipped (Duplicates)','Rejected (Total)','Rejected (Vendor)','Rejected (Min Order)','Rejected Items','Rejection Reasons','Stopped At','Error'];

// Column name overrides: source header → dest header (when names differ)
const COL_NAME_OVERRIDES = {
  'cancel reason': 'cancel',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function findLogFile() {
  return null; // log is now in Google Sheets (GSHEET_LOG_ID)
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
      httpsGet(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchUrl(res.headers.location, hops + 1));
          return;
        }
        if (res.statusCode !== 200) return reject(new Error(`GSheet HTTP ${res.statusCode}`));
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
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

async function writeExecuteLog({ runId, status, exportedRows, appendedRows, skippedRows, rejectedRows, rejectedVendor, rejectedMinOrder, rejectedItems, rejectionReasons, stoppedAt, error }) {
  try {
    const sheets = await getSheetClient();

    const d = new Date(), p = v => String(v).padStart(2, '0');
    await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_LOG_ID,
      range: `'${GSHEET_EXEC_TAB}'!A:N`,
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

// ─── STEP 1 & 2: LAUNCH & CONNECT ────────────────────────────────────────────
async function launchChrome() {
  // no-op: browser is launched directly by connectAndNavigate()
}

async function connectAndNavigate() {
  log('Launching Chrome...');
  const browser  = await chromium.launch({ headless: HEADLESS, channel: 'chrome' });
  const context  = await browser.newContext();
  const page     = await context.newPage();
  return { browser, context, page };
}

// ─── STEP 3: SELECT DATABASE ──────────────────────────────────────────────────
async function selectDatabase(page) {
  log('Navigating to database selector...');
  await page.goto(DB_SELECTOR_URL);
  await page.waitForLoadState('networkidle');

  // Click the most recent princ-smarterp-prod-base-* database
  await page.click('a[href*="princ-smarterp-prod-base-"]');
  await page.waitForLoadState('load');
  log(`Database selected, URL: ${page.url()}`);
}

// ─── STEP 4: LOGIN ────────────────────────────────────────────────────────────
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

// ─── STEP 5: SWITCH BU ────────────────────────────────────────────────────────
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

// ─── STEP 6: NAVIGATE TO GENERATE PR TO PO ───────────────────────────────────
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

// ─── STEP 7: REMOVE DEFAULT FILTER ───────────────────────────────────────────
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

// ─── STEP 8: GROUP BY BUYER ───────────────────────────────────────────────────
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

// ─── STEP 9: CLICK SUPPLY_BUYER ───────────────────────────────────────────────
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

// ─── STEP 10: EXPORT XLSX ─────────────────────────────────────────────────────
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
  const { writeFileSync } = await import('fs');
  const filePath = `${DOWNLOAD_PATH}\\odoo_export_temp.xlsx`;
  let captured = false;

  await page.route('**/web/export/xlsx', async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    writeFileSync(filePath, body);
    captured = true;
    log(`Captured export response (${body.length} bytes)`);
    // Respond with inline HTML so Chrome doesn't trigger a file download
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' });
  });

  await page.click('.o_export_data_dialog .o_select_button');

  // Wait for route to capture the file
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (captured) break;
  }
  if (!captured) throw new Error('Export request not captured — check network route');

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

// ─── STEP 11: GET NEW ROWS (dedup only — no write yet) ───────────────────────
async function appendToLog(exportPath, _logPath) {
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

// ─── STEP 12: VALIDATE (VENDOR + MIN ORDER) THEN APPEND ─────────────────────
async function validateAndAppend(newRows, headers) {
  if (newRows.length === 0) {
    return { appended: 0, total: 0, vendor: 0, minOrder: 0, items: '', reasons: '' };
  }

  log('Fetching vendor & minimum order reference from Google Sheet...');
  let refRows;
  try {
    refRows = await fetchGSheetCSV();
  } catch (e) {
    log(`WARNING: Could not fetch reference GSheet (${e.message}) — appending all rows without validation`);
    const sheets = await getSheetClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_LOG_ID, range: GSHEET_LOG_TAB,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
    return { appended: newRows.length, total: 0, vendor: 0, minOrder: 0, items: '', reasons: '' };
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

  const passingRows     = [];
  let vendorFailCount   = 0;
  let minOrderFailCount = 0;
  const rejectedItems   = [];
  const rejectedReasons = [];

  for (const [prNum, rows] of prGroups) {
    let prRejected = false;
    let rejReason  = '';
    let rejTag     = '';

    // ── 1. Vendor check (per row — wrong vendor rejects whole PR) ─────────────
    outer:
    for (const row of rows) {
      const productRaw = (row[productIdx] || '').toString();
      const company    = (row[companyIdx] || '').toString();
      const vendorRaw  = vendorIdx >= 0 ? (row[vendorIdx] || '').toString().trim() : '';
      const buCode     = company.match(/\[([A-Z]+):/)?.[1] || '';
      const itemCode   = productRaw.match(/^\[(\d+)\]/)?.[1];
      if (!itemCode) continue;

      const refs = refMap.get(`${buCode}|${itemCode}`);
      if (!refs) continue;

      const logVendorCode = vendorRaw.match(/^\(([^)]+)\)/)?.[1]?.trim() || '';
      const logVendorName = vendorRaw.replace(/^\([^)]+\)\s*/, '').trim().toLowerCase();

      for (const ref of refs) {
        const refVendorCode = ref['Vendor Code'].trim();
        const refVendorName = ref['Vendor Name'].trim();
        if (!refVendorCode && !refVendorName) continue; // blank = any vendor OK

        const vendorOk =
          (refVendorCode && logVendorCode === refVendorCode) ||
          (refVendorName && logVendorName === refVendorName.toLowerCase());

        if (!vendorOk) {
          prRejected = true;
          rejTag     = 'vendor';
          rejReason  = `wrong vendor on [${itemCode}]: got "${vendorRaw}", expected "(${refVendorCode}) ${refVendorName}"`;
          log(`REJECTED PR ${prNum}: ${rejReason}`);
          break outer;
        }
      }
    }

    // ── 2. Minimum order check (sum Tax incl. per vendor within this PR) ──────
    if (!prRejected) {
      // vendorKey → { total, minRequired }
      const vendorTotals = new Map();
      for (const row of rows) {
        const productRaw = (row[productIdx] || '').toString();
        const company    = (row[companyIdx] || '').toString();
        const vendorRaw  = vendorIdx >= 0 ? (row[vendorIdx] || '').toString().trim() : '';
        const taxIncl    = parseFloat(row[taxIdx]) || 0;
        const buCode     = company.match(/\[([A-Z]+):/)?.[1] || '';
        const itemCode   = productRaw.match(/^\[(\d+)\]/)?.[1];
        if (!itemCode) continue;

        const refs = refMap.get(`${buCode}|${itemCode}`);
        if (!refs) continue;

        const minRequired = Math.max(...refs.map(r => parseFloat(r['Minimum Order']) || 0));
        if (!minRequired) continue;

        if (!vendorTotals.has(vendorRaw)) vendorTotals.set(vendorRaw, { total: 0, minRequired });
        else vendorTotals.get(vendorRaw).minRequired = Math.max(vendorTotals.get(vendorRaw).minRequired, minRequired);
        vendorTotals.get(vendorRaw).total += taxIncl;
      }

      for (const [vendor, { total, minRequired }] of vendorTotals) {
        if (total < minRequired) {
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
    }
  }

  // Append only passing rows
  if (passingRows.length > 0) {
    const sheets = await getSheetClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_LOG_ID, range: GSHEET_LOG_TAB,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: passingRows },
    });
  }

  const totalRejected = rejectedItems.length;
  log(`Appended ${passingRows.length} row(s). Rejected ${totalRejected} PR(s).`);
  if (totalRejected === 0) log('All PRs passed vendor and minimum order checks');

  return {
    appended:  passingRows.length,
    total:     totalRejected,
    vendor:    vendorFailCount,
    minOrder:  minOrderFailCount,
    items:     rejectedItems.join(', '),
    reasons:   rejectedReasons.join('; '),
  };
}

// ─── STEP 13: CLEANUP ────────────────────────────────────────────────────────
function cleanup({ filePath }) {
  try {
    unlinkSync(filePath);
    log(`Deleted export file: ${filePath}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`WARNING: Could not delete export file: ${e.message}`);
  }
}

// ─── OPERATOR ─────────────────────────────────────────────────────────────────
const MAX_RETRIES   = 3;
const RETRY_BACKOFF = 3000;

const RUN_ID = (() => {
  const n = new Date(), p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
})();

const CP = {
  A: { name: 'A', steps: '1–3',   desc: 'browser + DB ready' },
  B: { name: 'B', steps: '4–6',   desc: 'logged in + BU selected' },
  C: { name: 'C', steps: '7–10',  desc: 'navigation + export' },
  D: { name: 'D', steps: '11–13', desc: 'post-export processing' },
};

class EarlyExit extends Error {
  constructor(reason, step) {
    super(reason);
    this.isEarlyExit = true;
    this.failedStep  = step;
  }
}

function structuredLog({ step, status, severity, type, message, confidence, checkpoint, recovery, action }) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `[${ts}]`,
    `RUN_ID    : ${RUN_ID}`,
    `STEP      : ${step}`,
    `STATUS    : ${status}`,
    `SEVERITY  : ${severity}`,
  ];
  if (type)       lines.push(`TYPE      : ${type}`);
  if (message)    lines.push(`MESSAGE   : ${message}`);
  if (confidence) lines.push(`CONFIDENCE: ${confidence}`);
  if (checkpoint) lines.push(`CHECKPOINT: ${checkpoint.name} (steps ${checkpoint.steps}) — ${checkpoint.desc}`);
  if (recovery)   lines.push(`RECOVERY  : ${recovery}`);
  if (action)     lines.push(`ACTION    : ${action}`);
  console.log('\n' + lines.join('\n') + '\n');
}

function diagnose(err) {
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes('timeout'))                                         return { severity: 'ERROR', type: 'TimeoutError',    confidence: 'HIGH — element not rendered or page too slow' };
  if (msg.includes('net::') || msg.includes('err_'))                  return { severity: 'ERROR', type: 'NetworkError',    confidence: 'HIGH — connectivity issue' };
  if (msg.includes('not found') || msg.includes('cannot read'))       return { severity: 'ERROR', type: 'ElementNotFound', confidence: 'MEDIUM — selector may have changed' };
  if (msg.includes('cannot connect') || msg.includes('econnrefused')) return { severity: 'FATAL', type: 'ConnectionError', confidence: 'HIGH — Chrome or Odoo unreachable' };
  return { severity: 'ERROR', type: 'UnknownError', confidence: 'LOW — manual inspection required' };
}

async function runCheckpoint(name, fn, recovery) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let currentStep = '?';
    try {
      return await fn(s => { currentStep = s; });
    } catch (err) {
      if (err.isEarlyExit) throw err;

      const diagnosis     = diagnose(err);
      const isLastAttempt = attempt === MAX_RETRIES;

      structuredLog({
        step: currentStep, status: 'FAILED', ...diagnosis,
        message: err.message, checkpoint: CP[name],
        recovery: isLastAttempt ? 'Max retries reached' : recovery,
        action:   isLastAttempt ? 'ESCALATE' : `Retry ${attempt}/${MAX_RETRIES}`,
      });

      if (diagnosis.severity === 'FATAL' || isLastAttempt) {
        err.failedStep  = currentStep;
        err.isEscalated = true;
        structuredLog({ step: currentStep, status: 'ESCALATED', ...diagnosis, message: err.message, action: `Failed ${attempt}/${MAX_RETRIES} — manual intervention required` });
        throw err;
      }

      await new Promise(r => setTimeout(r, RETRY_BACKOFF * attempt));
    }
  }
}

async function checkpointA() {
  return runCheckpoint('A', async (track) => {
    track('1/13 launchChrome');       await launchChrome();
    track('2/13 connectAndNavigate'); const conn = await connectAndNavigate();
    track('3/13 selectDatabase');     await selectDatabase(conn.page);
    return conn;
  }, 'Restart Checkpoint A — re-launch Chrome and reconnect');
}

async function checkpointB(page) {
  return runCheckpoint('B', async (track) => {
    track('4/13 login');              await login(page);
    track('5/13 switchBU');           await switchBU(page);
    track('6/13 navigateToPRtoPO');   await navigateToPRtoPO(page);
  }, 'Restart Checkpoint B — re-login and switch BU');
}

async function checkpointC(page, attempt = 1) {
  return runCheckpoint('C', async (track) => {
    if (attempt > 1) { track('6↺ navigateToPRtoPO'); await navigateToPRtoPO(page); }
    track('7/13 removeFilter');    await removeFilter(page);
    track('8/13 groupByBuyer');    await groupByBuyer(page);
    track('9/13 clickSupplyBuyer');
    const hasData = await clickSupplyBuyer(page);
    if (!hasData) {
      structuredLog({
        step: '9/13 clickSupplyBuyer', status: 'WARN', severity: 'WARN', type: 'NoData',
        message: `No ${CONFIG.buyer} PRs found — list is empty or group missing`,
        confidence: 'MEDIUM — verify Generate PR to PO has pending PRs today',
        action: 'STOPPING — nothing to process',
      });
      throw new EarlyExit(`No ${CONFIG.buyer} PRs found — nothing to process`, '9/13 clickSupplyBuyer');
    }
    track('10/13 exportXLSX');
    const exportPaths = await exportXLSX(page);
    if (!exportPaths?.filePath || !existsSync(exportPaths.filePath)) throw new Error('Export file not created — zero rows or export failed');
    return exportPaths;
  }, 'Navigate back to Generate PR to PO, re-run steps 7–10');
}

async function checkpointD(exportPaths, logPath, runStats) {
  return runCheckpoint('D', async (track) => {
    track('11/13 appendToLog');
    const { newRows, headers, skipped, exported } = await appendToLog(exportPaths.filePath, logPath);
    runStats.exportedRows = exported;
    runStats.skippedRows  = skipped;

    if (newRows.length === 0) {
      structuredLog({
        step: '11/13 appendToLog', status: 'WARN', severity: 'WARN', type: 'ZeroRows',
        message: 'No new rows after dedup — all may be duplicates or export was empty',
        confidence: 'MEDIUM — verify SUPPLY_BUYER has pending PRs today',
        action: 'STOPPING — manual check required',
      });
      cleanup(exportPaths);
      throw new EarlyExit('All rows were duplicates — nothing new to process', '11/13 appendToLog');
    }

    track('12/13 validateAndAppend');
    const rej = await validateAndAppend(newRows, headers);
    runStats.appendedRows     = rej?.appended  ?? 0;
    runStats.rejectedRows     = rej?.total     ?? 0;
    runStats.rejectedVendor   = rej?.vendor    ?? 0;
    runStats.rejectedMinOrder = rej?.minOrder  ?? 0;
    runStats.rejectedItems    = rej?.items     ?? '';
    runStats.rejectionReasons = rej?.reasons   ?? '';

    track('13/13 cleanup');
    cleanup(exportPaths);
  }, 'Restart Checkpoint D — re-run post-export processing');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const logPath = process.argv.find(a => a.endsWith('.xlsx')) || findLogFile();
  console.log(`[OPERATOR] PR2PO starting — RUN_ID: ${RUN_ID} | Profile: ${CONFIG.profileKey.toUpperCase()} | BU: ${CONFIG.bu}`);
  console.log(`[OPERATOR] Log tab: ${CONFIG.logTab}`);

  const runStats = {
    runId: RUN_ID, status: 'SUCCESS',
    exportedRows: null, appendedRows: null, skippedRows: null,
    rejectedRows: null, rejectedVendor: null, rejectedMinOrder: null, rejectedItems: null, rejectionReasons: null,
    stoppedAt: null, error: null,
  };

  let conn;
  try {
    conn = await checkpointA();
    await checkpointB(conn.page);
    const exportPaths = await checkpointC(conn.page);
    await checkpointD(exportPaths, logPath, runStats);
    console.log(`\n[OPERATOR] RUN_ID: ${RUN_ID} — COMPLETED SUCCESSFULLY`);
  } catch (err) {
    if (err.isEarlyExit) {
      runStats.status    = 'WARN';
      runStats.stoppedAt = err.failedStep || '';
      runStats.error     = err.message;
      console.log(`\n[OPERATOR] RUN_ID: ${RUN_ID} — WARN: ${err.message}`);
    } else {
      runStats.status    = err.isEscalated ? 'ESCALATED' : 'FAILED';
      runStats.stoppedAt = err.failedStep || '';
      runStats.error     = err.message;
      console.error(`\n[OPERATOR] RUN_ID: ${RUN_ID} — ${runStats.status}: ${err.message}`);
    }
  } finally {
    await Promise.all([
      conn?.browser ? conn.browser.close().catch(() => {}) : Promise.resolve(),
      writeExecuteLog(runStats),
    ]);
    if (runStats.status === 'FAILED' || runStats.status === 'ESCALATED') process.exit(1);
  }
})();
