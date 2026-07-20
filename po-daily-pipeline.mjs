/**
 * po-daily-pipeline.mjs — Full PO pipeline in one script (v2)
 * Print (Odoo) → Split (per-PO PDFs by vendor) → Upload (Google Shared Drive)
 *
 * Usage:
 *   node po-daily-pipeline.mjs                        # all stages, today (defaults to PSV)
 *   node po-daily-pipeline.mjs --bu PSUV              # specify BU code
 *   node po-daily-pipeline.mjs --date 2026-05-26      # specific date
 *   node po-daily-pipeline.mjs --headless              # headless browser
 *   node po-daily-pipeline.mjs --skip-print            # skip Odoo, use existing PDFs in Downloads
 *   node po-daily-pipeline.mjs --skip-split            # skip split, use existing split dir
 *   node po-daily-pipeline.mjs --upload-folder <id>   # override Google Drive folder ID
 *
 * v2 changes vs original:
 * - FIX: vendor-less split PDFs (SPLIT_DIR root) are now uploaded to the year
 *   folder on Drive with a warning, instead of being silently skipped
 * - FIX: vendor carry-forward resets at PO boundaries — a PO whose vendor line
 *   fails to parse no longer inherits the previous PO's vendor
 * - FIX: vendor folder names sanitized for invalid filesystem characters
 * - FIX: OAuth timeout timer cleared on success (no 5-min exit delay on first run)
 * - FIX: token-refresh listener wired on first auth too, not only on saved-token runs
 * - FIX: --date validated; invalid input now errors instead of "no POs found"
 * - Pages before the first detected PO number are now counted and logged
 * - Removed unneeded `URL as NodeURL` import (URL is a Node global)
 */

import { chromium } from 'playwright';
import { createRequire } from 'module';
import { PDFDocument } from 'pdf-lib';
import { google } from 'googleapis';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, createReadStream,
} from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname, extname } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { ODOO_URL, BU_ODOO_PREFIX, BU_ORDER_FOLDERS } from './lib/config.mjs';
import { loadEnv, log, makeRunId, cfAccessHeaders } from './lib/util.mjs';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));

loadEnv(join(__dir, '.env'));

const HEADLESS       = process.argv.includes('--headless');
const SKIP_PRINT     = process.argv.includes('--skip-print');
const SKIP_SPLIT     = process.argv.includes('--skip-split');
const _buIdx         = process.argv.indexOf('--bu');
const TARGET_BU_CODE = _buIdx !== -1 ? process.argv[_buIdx + 1] : 'PSV';
const DOWNLOADS_DIR  = join(homedir(), 'Downloads');

const TOKEN_FILE     = join(__dir, '.gdrive-po-token.json');
const REDIRECT       = 'http://localhost:3000/callback';

const _dateIdx     = process.argv.indexOf('--date');
const _d           = _dateIdx !== -1 ? new Date(process.argv[_dateIdx + 1]) : new Date();
if (isNaN(_d.getTime()))
  throw new Error(`Invalid --date "${process.argv[_dateIdx + 1]}" — expected e.g. 2026-05-26`);
const _day  = _d.getDate();
const _mon  = _d.toLocaleString('en-GB', { month: 'short' });
const _year = _d.getFullYear();
const _p2   = v => String(v).padStart(2, '0');
const TARGET_DATE  = `${_day} ${_mon} ${_year}`; // display/logging only
// Word-boundary match ("7 Jul 2026" must NOT match "17 Jul 2026"); tolerates zero-padded day
const TARGET_DATE_RE = new RegExp(`(?<!\\d)0?${_day} ${_mon} ${_year}`);
const TARGET_MONTH = `${_d.toLocaleString('en-GB', { month: 'long' })} ${_year}`;
const DATE_SLUG    = `${_year}${_p2(_d.getMonth() + 1)}${_p2(_day)}`;
const SPLIT_DIR    = join(DOWNLOADS_DIR, `PO-${TARGET_BU_CODE}-Split-${DATE_SLUG}`);

const _folderIdx      = process.argv.indexOf('--upload-folder');
const ORDER_FOLDER    = _folderIdx !== -1
  ? process.argv[_folderIdx + 1]
  : (BU_ORDER_FOLDERS[TARGET_BU_CODE] ?? (() => { throw new Error(`No Drive folder configured for BU "${TARGET_BU_CODE}"`); })());

const USERNAME = process.env.ODOO_USERNAME;
const PASSWORD = process.env.ODOO_PASSWORD;

const WARNINGS = [];
function logWarning(stage, msg) {
  WARNINGS.push(`[${stage}] ${msg}`);
  log(stage, `WARNING: ${msg}`);
}

const RUN_ID = makeRunId();

const PRINT_MAX_RETRIES   = 3;
const PRINT_RETRY_BACKOFF = 3000;

// stagePrint opens/closes its own browser per call, so retrying the whole
// function is safe — each attempt starts from a clean session.
async function withRetry(name, fn) {
  for (let attempt = 1; attempt <= PRINT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === PRINT_MAX_RETRIES;
      log(name, `FAILED (attempt ${attempt}/${PRINT_MAX_RETRIES}): ${err.message}`);
      if (isLast) throw err;
      await new Promise(r => setTimeout(r, PRINT_RETRY_BACKOFF * attempt));
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STAGE 1 — PRINT
// ══════════════════════════════════════════════════════════════════════════════

async function stagePrint() {
  if (!USERNAME || !PASSWORD) throw new Error('ODOO_USERNAME / ODOO_PASSWORD not set in .env');

  log('PRINT', 'Launching Chrome...');
  const browser = await chromium.launch({ headless: HEADLESS, channel: 'chrome' });
  let page;
  try {
    // Inside the try so a newContext/newPage failure still hits the finally —
    // withRetry reruns stagePrint, so each leak would be one orphan Chrome.
    // extraHTTPHeaders carries the Cloudflare Access service token when set
    // (empty {} = no-op on inside-network runs); scoped to Odoo requests only.
    const context = await browser.newContext({ extraHTTPHeaders: cfAccessHeaders() });
    page = await context.newPage();
    log('PRINT', 'Selecting database...');
    await page.goto(`${ODOO_URL}/web/database/selector`);
    await page.waitForSelector('a[href*="princ-smarterp-prod-base-"]');
    await page.click('a[href*="princ-smarterp-prod-base-"]');
    await page.waitForLoadState('load');

    if (page.url().includes('/login')) {
      log('PRINT', 'Logging in...');
      await page.fill('input[name="login"]', USERNAME);
      await page.fill('input[name="password"]', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('load');
      await page.waitForSelector('.o_main_navbar');
      log('PRINT', 'Logged in');
    }

    log('PRINT', `Switching to BU ${TARGET_BU_CODE}...`);
    await page.waitForSelector('.o_main_navbar', { timeout: 30000 });
    let switcherFound = false;
    try { await page.waitForSelector('.o_switch_company_menu', { timeout: 5000, state: 'attached' }); switcherFound = true; } catch {}
    if (switcherFound) {
      await page.click('.o_switch_company_menu button');
      await page.waitForTimeout(1000);
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
      await page.click(`[data-company-id="${target.id}"] .log_into`);
      await page.waitForLoadState('load');
      await page.waitForTimeout(2000);
      log('PRINT', `Switched to ${target.label}`);
    }

    log('PRINT', 'Navigating to Purchase Orders...');
    await page.waitForSelector('.o_navbar_apps_menu button');
    await page.click('.o_navbar_apps_menu button');
    await page.waitForSelector('a.o_app[href*="menu_id=340"]');
    await page.click('a.o_app[href*="menu_id=340"]');
    await page.waitForSelector('.o_menu_sections');
    await page.locator('.o_menu_sections button').filter({ hasText: 'Orders' }).click();
    await page.locator('.dropdown-item').filter({ hasText: 'Purchase Orders' }).first().waitFor();
    await page.locator('.dropdown-item').filter({ hasText: 'Purchase Orders' }).first().click();
    await page.waitForSelector('.o_searchview');

    log('PRINT', 'Applying group-by filters...');
    await page.click('.o_searchview_dropdown_toggler');
    await page.waitForSelector('.o_group_by_menu');
    const hasConfDate = await page.locator('.o_searchview_facet').filter({ hasText: 'Confirmation Date' }).count() > 0;
    if (!hasConfDate) {
      await page.selectOption('select.o_add_custom_group_menu', { label: 'Confirmation Date' });
      await page.locator('.o_group_by_menu .o_menu_item').filter({ hasText: 'Confirmation Date' }).first().waitFor();
      await page.locator('.o_group_by_menu .o_menu_item').filter({ hasText: 'Confirmation Date' }).first().click();
      await page.waitForTimeout(600);
    }
    const accordion = page.locator('.o_accordion').filter({
      has: page.locator('.o_accordion_toggle').filter({ hasText: 'Confirmation Date' }),
    });
    const toggle = accordion.locator('.o_accordion_toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') {
      await toggle.click();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('.o_accordion_toggle'))
          .find(b => b.textContent.trim() === 'Confirmation Date')?.getAttribute('aria-expanded') === 'true'
      );
    }
    const panel = accordion.locator('.o_accordion_values');
    for (const name of ['Month', 'Day']) {
      const item = panel.locator('[role=menuitemcheckbox]').filter({ hasText: name });
      if (await item.getAttribute('aria-checked') !== 'true') await item.click();
    }
    await page.waitForTimeout(800);
    await toggle.click();
    await page.waitForTimeout(600);
    const hasProductBuyer = await page.locator('.o_searchview_facet').filter({ hasText: 'Product Buyer' }).count() > 0;
    if (!hasProductBuyer) {
      await page.selectOption('select.o_add_custom_group_menu', { label: 'Product Buyer' });
      await page.locator('.o_group_by_menu .o_menu_item').filter({ hasText: 'Product Buyer' }).first().waitFor();
      await page.locator('.o_group_by_menu .o_menu_item').filter({ hasText: 'Product Buyer' }).first().click();
      await page.waitForTimeout(600);
    }
    await page.click('.o_searchview_dropdown_toggler');
    await page.waitForTimeout(1500);

    log('PRINT', `Expanding ${TARGET_DATE}...`);

    // Guard: check if the month group exists at all
    const monthHeader = page.locator('.o_group_header').filter({ hasText: TARGET_MONTH }).first();
    if (!await monthHeader.isVisible().catch(() => false)) {
      log('PRINT', `No POs found for ${TARGET_MONTH} — nothing to do`);
      return [];
    }
    await monthHeader.click();
    await page.waitForTimeout(1000);

    // Guard: check if today's date sub-group exists within the month
    const dayHeader = page.locator('.o_group_header').filter({ hasText: TARGET_DATE_RE }).first();
    try {
      await dayHeader.waitFor({ timeout: 5000 });
    } catch {
      log('PRINT', `No POs found for ${TARGET_DATE} — nothing to do`);
      return [];
    }
    await dayHeader.click();
    await page.waitForSelector('thead .o_list_controller input[type=checkbox]');
    await page.waitForTimeout(2000);

    const savedFiles = [];
    let pageNum = 1;
    while (true) {
      const cb = page.locator('thead .o_list_controller input[type=checkbox]');
      const alreadyChecked = await cb.evaluate(el => el.checked || el.indeterminate);
      if (alreadyChecked) { await cb.click(); await page.waitForTimeout(500); }
      await cb.click();
      await page.waitForSelector('.o_list_selection_box', { timeout: 20000 });
      const sel = await page.locator('.o_list_selection_box').textContent();
      log('PRINT', `Page ${pageNum} — ${sel?.trim()}`);

      await page.locator('.o_cp_action_menus button').filter({ hasText: 'Print' }).click();
      await page.locator('.dropdown-item').filter({ hasText: 'Purchase Order' }).first().waitFor();
      const pdfDone = page.waitForResponse(
        r => r.url().includes('/report/') || (r.headers()['content-type'] || '').includes('pdf')
      );
      await page.locator('.dropdown-item').filter({ hasText: 'Purchase Order' }).first().click();
      const pdfBuffer = await (await pdfDone).body();
      // The response filter is loose (any /report/ URL matches) — a JSON or
      // HTML error response written as .pdf would only surface in the split
      // stage as a cryptic pdf-parse failure. Fail here, where retry helps.
      if (!pdfBuffer.subarray(0, 5).toString('latin1').startsWith('%PDF'))
        throw new Error(`Report response is not a PDF (starts with "${pdfBuffer.subarray(0, 20).toString('latin1')}") — report render failed?`);
      const filename  = `PO-${TARGET_BU_CODE}-${DATE_SLUG}-p${pageNum}.pdf`;
      const outPath   = join(DOWNLOADS_DIR, filename);
      writeFileSync(outPath, pdfBuffer);
      savedFiles.push(outPath);
      log('PRINT', `Saved → ${filename}`);

      const dayHeader = page.locator('.o_group_header').filter({ hasText: TARGET_DATE_RE }).first();
      const pagerText = (await dayHeader.locator('.o_pager_counter').textContent().catch(() => '')).trim();
      const match = pagerText.match(/(\d+)-(\d+)\s*\/\s*(\d+)/);
      if (!match || parseInt(match[2]) >= parseInt(match[3])) break;

      await dayHeader.locator('.o_pager_next').click();
      await page.waitForFunction(
        ({ hdrReSrc, prev }) => {
          const hdrRe = new RegExp(hdrReSrc);
          const h = Array.from(document.querySelectorAll('.o_group_header')).find(el => hdrRe.test(el.textContent));
          return h?.querySelector('.o_pager_counter')?.textContent?.trim() !== prev;
        },
        { hdrReSrc: TARGET_DATE_RE.source, prev: pagerText },
        { timeout: 10000 }
      );
      await page.waitForTimeout(3000);
      pageNum++;
    }

    log('PRINT', `Done — ${savedFiles.length} file(s) saved`);
    return savedFiles;
  } finally {
    await browser.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// STAGE 2 — SPLIT
// ══════════════════════════════════════════════════════════════════════════════

const PO_REGEX     = /\d{2}PO\d{8}/;
const HN_EXTRACT   = /HN[>: ]\s*:?\s*(\d{2})-(\d{2})-\s*(\d{6})/g;
const CASE_REGEX   = /เคสวันที่|วันที่ท[าํ]เคส/;
const VENDOR_REGEX = /Supplier:\s*(\d{10})\s*:\s*(.+?)(?=\s*ที่อยู่)/;

function extractHNs(text) {
  const found = [], seen = new Set();
  for (const m of text.matchAll(HN_EXTRACT)) {
    const clean = `HN${m[1]}-${m[2]}-${m[3]}`;
    if (!seen.has(clean)) { seen.add(clean); found.push(clean); }
  }
  return found;
}

function extractPageInfo(text, idx) {
  const poMatch  = text.match(PO_REGEX);
  const hns      = extractHNs(text);
  const venMatch = text.match(VENDOR_REGEX);
  return {
    page:       idx,
    po:         poMatch  ? poMatch[0]         : null,
    hns,
    clearing:   hns.length > 0 || CASE_REGEX.test(text),
    vendorCode: venMatch ? venMatch[1]        : null,
    vendorName: venMatch ? venMatch[2].trim() : null,
  };
}

async function extractAllPageInfo(buf) {
  const pages = [];
  await pdfParse(buf, {
    pagerender: pageData =>
      pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then(tc => {
        const text = tc.items.map(i => i.str).join(' ');
        pages.push(extractPageInfo(text, pages.length));
        return text;
      }),
  });
  return pages;
}

// Strip characters invalid in Windows folder names
function sanitizeFolderName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim();
}

function resolveVendorFolder(baseDir, vendorCode, vendorName) {
  let entries = [];
  try { entries = readdirSync(baseDir, { withFileTypes: true }); } catch {}
  const existing = entries.find(e => e.isDirectory() && e.name.includes(`(${vendorCode})`));
  if (existing) return join(baseDir, existing.name);
  const folderPath = join(baseDir, sanitizeFolderName(`${vendorName} (${vendorCode})`));
  mkdirSync(folderPath, { recursive: true });
  return folderPath;
}

async function splitOnePdf(inputPath) {
  log('SPLIT', `Processing ${inputPath}`);
  const buf   = readFileSync(inputPath);
  const pages = await extractAllPageInfo(buf);

  // Forward-fill PO and vendor across continuation pages.
  // Vendor resets at each new PO so a PO with an unparseable vendor line
  // does NOT inherit the previous PO's vendor (would file it under the wrong vendor).
  let last = { po: null, vendorCode: null, vendorName: null };
  for (const p of pages) {
    if (p.po && p.po !== last.po) {
      last = { po: p.po, vendorCode: null, vendorName: null };
    }
    if (p.po)         last.po         = p.po;         else p.po         = last.po;
    if (p.vendorCode) last.vendorCode = p.vendorCode; else p.vendorCode = last.vendorCode;
    if (p.vendorName) last.vendorName = p.vendorName; else p.vendorName = last.vendorName;
  }

  const orphanPages = pages.filter(p => !p.po).length;
  if (orphanPages > 0) logWarning('SPLIT', `${orphanPages} page(s) before first PO number — dropped`);

  const groups = new Map();
  for (const p of pages) {
    if (!p.po) continue;
    if (!groups.has(p.po)) groups.set(p.po, { pages: [], hns: new Set(), clearing: false, vendorCode: p.vendorCode, vendorName: p.vendorName });
    const g = groups.get(p.po);
    g.pages.push(p.page);
    p.hns.forEach(hn => g.hns.add(hn));
    if (p.clearing)                    g.clearing   = true;
    if (p.vendorCode && !g.vendorCode) g.vendorCode = p.vendorCode;
    if (p.vendorName && !g.vendorName) g.vendorName = p.vendorName;
  }

  const srcDoc = await PDFDocument.load(buf);
  let written = 0;

  for (const [poNum, { pages: pageIdxs, hns, clearing, vendorCode, vendorName }] of groups) {
    const destDoc = await PDFDocument.create();
    const copied  = await destDoc.copyPages(srcDoc, pageIdxs);
    for (const p of copied) destDoc.addPage(p);
    const pdfBytes = await destDoc.save();

    const hnSuffix = hns.size > 0 ? ' ' + [...hns].join(' ') : '';
    const filename = `${poNum}${hnSuffix}.pdf`;

    let folder = SPLIT_DIR;
    if (vendorCode && vendorName) folder = resolveVendorFolder(SPLIT_DIR, vendorCode, vendorName);
    else logWarning('SPLIT', `${poNum} has no vendor info — saved to split root`);

    writeFileSync(join(folder, filename), pdfBytes);
    log('SPLIT', `  ${filename}${clearing ? ' [Clearing]' : ''}`);
    written++;
  }

  return written;
}

async function stageSplit(pdfFiles) {
  mkdirSync(SPLIT_DIR, { recursive: true });
  let total = 0;
  for (const f of pdfFiles) total += await splitOnePdf(f);
  log('SPLIT', `Done — ${total} PO file(s) → ${SPLIT_DIR}`);
  return total;
}

// ══════════════════════════════════════════════════════════════════════════════
// STAGE 3 — UPLOAD
// ══════════════════════════════════════════════════════════════════════════════

async function authorizeGDrive() {
  const { GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET } = process.env;
  if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET)
    throw new Error('GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET not set in .env');

  const auth = new google.auth.OAuth2(GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, REDIRECT);

  // Persist refreshed tokens on every run (saved-token and first-auth alike)
  auth.on('tokens', tokens => {
    const saved = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : {};
    writeFileSync(TOKEN_FILE, JSON.stringify({ ...saved, ...tokens }, null, 2));
  });

  if (existsSync(TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));
    return auth;
  }

  const url = auth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive'] });
  console.log('\n[UPLOAD] Auth needed. Open this URL in your browser:\n\n' + url + '\n');
  const code = await new Promise((resolve, reject) => {
    let timer;
    const server = createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost:3000');
      if (u.pathname === '/callback') {
        const authCode = u.searchParams.get('code');
        if (!authCode) {
          // Consent denied / error redirect — reject here, or getToken(null)
          // fails later with a baffling Google error
          res.end('<h1>Authorization failed — no code received.</h1>');
          clearTimeout(timer);
          server.close();
          reject(new Error(`OAuth callback returned no code (${u.searchParams.get('error') || 'consent denied?'})`));
          return;
        }
        res.end('<h1>Authorized! You can close this tab.</h1>');
        clearTimeout(timer);
        server.close();
        resolve(authCode);
      }
    });
    // Without this, EADDRINUSE (port 3000 busy — e.g. PR2PO's OAuth flow)
    // is an unhandled 'error' event that crashes the process outside the
    // promise: no SUMMARY block, no clean FAILED path
    server.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`OAuth callback server failed: ${err.message}`));
    });
    server.listen(3000);
    timer = setTimeout(() => { server.close(); reject(new Error('Auth timeout (5 min)')); }, 300_000);
  });

  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  log('UPLOAD', 'Token saved — future runs will be silent');
  return auth;
}

async function findOrCreateFolder(drive, name, parentId) {
  const safe = name.replace(/'/g, "\\'");
  const q    = `name='${safe}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res  = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (res.data.files.length) return res.data.files[0].id;
  const f = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  return f.data.id;
}

async function getExistingFiles(drive, folderId) {
  const existing = new Set();
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of res.data.files) existing.add(f.name);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return existing;
}

async function uploadDirToDrive(drive, localDir, driveFolderId, counters) {
  const pdfs = readdirSync(localDir, { withFileTypes: true })
    .filter(e => e.isFile() && extname(e.name).toLowerCase() === '.pdf')
    .map(e => e.name);
  if (!pdfs.length) return;

  const existingOnDrive = await getExistingFiles(drive, driveFolderId);

  for (const pdf of pdfs) {
    if (existingOnDrive.has(pdf)) {
      counters.skipped++;
      continue;
    }
    await drive.files.create({
      requestBody: { name: pdf, parents: [driveFolderId] },
      media: { mimeType: 'application/pdf', body: createReadStream(join(localDir, pdf)) },
      fields: 'id',
      supportsAllDrives: true,
    });
    counters.uploaded++;
    process.stdout.write(`\r[UPLOAD] ${counters.uploaded} uploaded, ${counters.skipped} skipped...`);
  }
}

async function stageUpload() {
  const auth  = await authorizeGDrive();
  const drive = google.drive({ version: 'v3', auth });

  const year       = String(_d.getFullYear());
  const yearFolder = await findOrCreateFolder(drive, year, ORDER_FOLDER);
  log('UPLOAD', `Year folder: ${year} (${yearFolder})`);

  const entries    = readdirSync(SPLIT_DIR, { withFileTypes: true });
  const vendorDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const rootPdfs   = entries.filter(e => e.isFile() && extname(e.name).toLowerCase() === '.pdf');

  log('UPLOAD', `${vendorDirs.length} vendor folder(s) → Drive:${ORDER_FOLDER}/${year}`);
  const counters = { uploaded: 0, skipped: 0 };

  for (const vendorName of vendorDirs) {
    const vendorDriveId = await findOrCreateFolder(drive, vendorName, yearFolder);
    await uploadDirToDrive(drive, join(SPLIT_DIR, vendorName), vendorDriveId, counters);
  }

  // Vendor-less PDFs in the split root: upload to the year folder so nothing is lost
  if (rootPdfs.length > 0) {
    logWarning('UPLOAD', `${rootPdfs.length} PDF(s) without vendor folder — uploading to year folder root`);
    await uploadDirToDrive(drive, SPLIT_DIR, yearFolder, counters);
  }

  console.log(`\n[UPLOAD] Done — ${counters.uploaded} uploaded, ${counters.skipped} already existed (skipped)`);
  return counters;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

(async () => {
  console.log(`\n── PO Daily Pipeline ── RUN_ID: ${RUN_ID} — ${TARGET_DATE} ${'─'.repeat(Math.max(0, 40 - TARGET_DATE.length))}`);
  console.log(`   Print: ${SKIP_PRINT ? 'SKIP' : 'ON'} | Split: ${SKIP_SPLIT ? 'SKIP' : 'ON'} | Drive: ${ORDER_FOLDER}`);
  console.log(`${'─'.repeat(56)}\n`);

  const runStats = {
    runId: RUN_ID, bu: TARGET_BU_CODE, date: TARGET_DATE, status: 'SUCCESS',
    printed: null, split: null, uploaded: null, skipped: null,
    warnings: null, stoppedAt: null, error: null,
  };
  let stage = 'PRINT';

  try {
    let pdfFiles;

    if (SKIP_PRINT) {
      pdfFiles = readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(`PO-${TARGET_BU_CODE}-${DATE_SLUG}`) && f.endsWith('.pdf'))
        .map(f => join(DOWNLOADS_DIR, f))
        .sort();
      if (!pdfFiles.length)
        throw new Error(`No PDFs found in ${DOWNLOADS_DIR} matching PO-${TARGET_BU_CODE}-${DATE_SLUG}-*.pdf`);
      log('PRINT', `Skipped — using ${pdfFiles.length} existing file(s)`);
      runStats.printed = pdfFiles.length;
    } else {
      pdfFiles = await withRetry('PRINT', stagePrint);
      runStats.printed = pdfFiles.length;
      if (pdfFiles.length === 0) {
        runStats.status    = 'WARN';
        runStats.stoppedAt = 'PRINT';
        runStats.error     = 'No POs found for target date';
        console.log('\n✅ Pipeline complete — no POs for today\n');
        return;
      }
    }

    stage = 'SPLIT';
    if (SKIP_SPLIT) {
      if (!existsSync(SPLIT_DIR)) throw new Error(`Split dir not found: ${SPLIT_DIR}`);
      log('SPLIT', `Skipped — using existing ${SPLIT_DIR}`);
    } else {
      runStats.split = await stageSplit(pdfFiles);
    }

    stage = 'UPLOAD';
    const uploadCounters = await stageUpload();
    runStats.uploaded = uploadCounters.uploaded;
    runStats.skipped  = uploadCounters.skipped;

    console.log('\n✅ Pipeline complete\n');
  } catch (err) {
    runStats.status    = 'FAILED';
    runStats.stoppedAt = stage;
    runStats.error     = err.message;
    console.error('\n❌', err.message);
  } finally {
    runStats.warnings = WARNINGS.length ? WARNINGS.join('; ') : null;
    console.log(`\n[SUMMARY] RUN_ID: ${RUN_ID} — ${runStats.status} | BU: ${runStats.bu} | Date: ${runStats.date}`);
    console.log(`  Printed: ${runStats.printed ?? '-'} | Split: ${runStats.split ?? '-'} | Uploaded: ${runStats.uploaded ?? '-'} | Skipped: ${runStats.skipped ?? '-'}`);
    if (runStats.warnings)  console.log(`  Warnings: ${runStats.warnings}`);
    if (runStats.stoppedAt) console.log(`  Stopped At: ${runStats.stoppedAt}`);
    if (runStats.error)     console.log(`  Error: ${runStats.error}`);
    // Persist the structured result so the batch runner can collect it. Only the
    // batch path sets PODAILY_RESULT_FILE; a direct single-BU run leaves it unset
    // and just prints the [SUMMARY] above. Mirrors PR2PO's PR2PO_RESULT_FILE so
    // run-po-daily-batch.mjs reads results the same way run-batch.mjs does.
    if (process.env.PODAILY_RESULT_FILE) {
      try { writeFileSync(process.env.PODAILY_RESULT_FILE, JSON.stringify(runStats, null, 2)); }
      catch (e) { console.error(`[RESULT] Could not write result file: ${e.message}`); }
    }
    if (runStats.status === 'FAILED') process.exit(1);
  }
})();
