/**
 * ODOO PR → PO Workflow Automation
 * BU: PSV | Credentials loaded from .env
 * Exports Generate PR to PO (SUPPLY_BUYER) and appends to Log file
 */

import { chromium } from 'playwright';
import XLSX from 'xlsx';
import { existsSync, readdirSync, readFileSync } from 'fs';
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
const TARGET_BU_CODE  = 'PSV';          // company code to switch to
const TARGET_BUYER    = 'SUPPLY_BUYER';
const CHROME_PATH     = findChrome();
const DEBUG_PORT      = 9222;
const DEBUG_PROFILE   = `${process.env.TEMP}\\chrome-debug-profile`;
const DOWNLOAD_PATH   = `${process.env.USERPROFILE}\\Downloads`;
const LOG_FILE             = process.argv[2] || findLogFile();
const MINIMUM_ORDER_FILE   = findMinimumOrderFile();
const MINIMUM_ORDER_SHEETS = { 'SUPPLY_BUYER': 'เวชภัณฑ์', 'MEDICINE_BUYER': 'ยา' };

// Column name overrides: source header → dest header (when names differ)
const COL_NAME_OVERRIDES = {
  'cancel reason': 'cancel',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function findChrome() {
  const candidates = [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  // Fall back to registry
  try {
    const reg = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve', { encoding: 'utf8' });
    const match = reg.match(/REG_SZ\s+(.+chrome\.exe)/i);
    if (match && existsSync(match[1].trim())) return match[1].trim();
  } catch {}
  throw new Error('Chrome not found. Install Google Chrome or pass the path manually.');
}

function findLogFile() {
  const desktop = `${process.env.USERPROFILE}\\Desktop`;
  try {
    const files = readdirSync(desktop);
    const match = files.find(f => f.includes('Log') && f.includes('PR') && f.includes('PO') && f.endsWith('.xlsx'));
    if (match) return `${desktop}\\${match}`;
  } catch {}
  throw new Error('Log file not found on Desktop. Pass path as argument: node odoo_pr_to_po.mjs "C:\\path\\to\\log.xlsx"');
}

function findMinimumOrderFile() {
  const desktop = `${process.env.USERPROFILE}\\Desktop`;
  try {
    const files = readdirSync(desktop);
    const match = files.find(f => f.includes('ขั้นต่ำ') && f.endsWith('.xlsx'));
    if (match) return `${desktop}\\${match}`;
  } catch {}
  throw new Error('Minimum order file not found on Desktop. Expected a .xlsx file with "ขั้นต่ำ" in the name.');
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

// ─── STEP 1: LAUNCH CHROME ────────────────────────────────────────────────────
async function isCDPReady() {
  try {
    const http = await import('http');
    return await new Promise(resolve => {
      const req = http.default.get(`http://localhost:${DEBUG_PORT}/json/version`, r => resolve(r.statusCode === 200));
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  } catch { return false; }
}

async function launchChrome() {
  // If Chrome is already ready on debug port, reuse it
  if (await isCDPReady()) {
    log('Chrome already running on debug port — reusing');
    return;
  }

  log('Launching Chrome with remote debugging...');

  // Clear old debug profile so the new instance starts clean
  try { execSync(`rmdir /s /q "${DEBUG_PROFILE}"`, { stdio: 'ignore' }); } catch {}

  const { spawn } = await import('child_process');
  spawn(CHROME_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${DEBUG_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
  ], { detached: true, stdio: 'ignore' }).unref();

  // Wait until CDP is actually ready (retry up to 15s)
  log('Waiting for Chrome CDP to be ready...');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isCDPReady()) { log('Chrome ready'); return; }
  }
  throw new Error('Chrome did not become ready in time');
}

// ─── STEP 2: CONNECT & NAVIGATE ───────────────────────────────────────────────
async function connectAndNavigate() {
  log('Connecting to Chrome via CDP...');
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  const page    = context.pages()[0];

  // Allow downloads via CDP
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_PATH,
    eventsEnabled: true,
  });

  return { browser, context, page, cdp };
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

  const target = companies.find(c => c.label.startsWith(`[${TARGET_BU_CODE}:`));
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
  await page.locator('.o_group_header').filter({ hasText: TARGET_BUYER }).first().click();
  await page.waitForTimeout(2000);
  log(`${TARGET_BUYER} expanded`);
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
    await route.fulfill({ response });
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

  return filePath;
}

// ─── STEP 11: APPEND TO LOG ───────────────────────────────────────────────────
async function appendToLog(exportPath, logPath) {
  log('Reading export file...');
  const srcWb   = XLSX.readFile(exportPath);
  const srcSheet = srcWb.Sheets[srcWb.SheetNames[0]];
  const srcAllRows = XLSX.utils.sheet_to_json(srcSheet, { header: 1 });
  const srcHeaders = srcAllRows[0];

  // Filter out group summary rows (e.g. "SUPPLY_BUYER (1)")
  const srcData = srcAllRows.slice(1).filter(r => !/ \(\d+\)$/.test(r[0]?.toString() || ''));
  log(`Real data rows to append: ${srcData.length}`);

  log('Reading log file...');
  const dstWb   = XLSX.readFile(logPath);
  const dstSheet = dstWb.Sheets[dstWb.SheetNames[0]];
  const dstRows  = XLSX.utils.sheet_to_json(dstSheet, { header: 1 });
  const dstHeaders = dstRows[0];

  // Build column mapping: source col B→O → destination col index
  const colMap = {};
  srcHeaders.slice(1, 15).forEach(srcCol => {
    const key = COL_NAME_OVERRIDES[srcCol?.toString().trim().toLowerCase()] || srcCol?.toString().trim().toLowerCase();
    colMap[srcCol] = dstHeaders.findIndex(h => h?.toString().trim().toLowerCase() === key);
  });

  const dateIdx = 0; // Column A = Date
  const todayStr = today();

  // Build set of existing Purchase Numbers to prevent duplicates
  const prNumIdx = dstHeaders.findIndex(h => h?.toString().toLowerCase().includes('purchase number'));
  const existingPRs = new Set(dstRows.slice(1).map(r => r[prNumIdx]).filter(Boolean));

  let appended = 0;
  srcData.forEach(srcRow => {
    const prNum = srcRow[srcHeaders.indexOf('Purchase Number')];
    if (existingPRs.has(prNum)) {
      log(`Skipping duplicate PR: ${prNum}`);
      return;
    }
    const newRow = new Array(dstHeaders.length).fill(undefined);
    newRow[dateIdx] = todayStr;
    srcHeaders.slice(1, 15).forEach((srcCol, i) => {
      const dstIdx = colMap[srcCol];
      if (dstIdx >= 0 && srcRow[i + 1] !== undefined) newRow[dstIdx] = srcRow[i + 1];
    });
    dstRows.push(newRow);
    existingPRs.add(prNum);
    appended++;
  });

  const newSheet = XLSX.utils.aoa_to_sheet(dstRows);
  dstWb.Sheets[dstWb.SheetNames[0]] = newSheet;
  XLSX.writeFile(dstWb, logPath);
  log(`Appended ${appended} row(s) with date ${todayStr} → ${logPath}`);
  return appended;
}

// ─── STEP 12: CHECK MINIMUM ORDER ────────────────────────────────────────────
async function checkMinimumOrder(logPath) {
  log('Checking minimum order requirements...');

  const sheetName = MINIMUM_ORDER_SHEETS[TARGET_BUYER];
  if (!sheetName) { log('No minimum order sheet mapped for this buyer — skipping'); return; }

  const minWb   = XLSX.readFile(MINIMUM_ORDER_FILE);
  const minWs   = minWb.Sheets[sheetName];
  const minRows = XLSX.utils.sheet_to_json(minWs, { header: 1 });
  const minData = minRows.slice(2); // data starts at row 3

  const logWb   = XLSX.readFile(logPath);
  const logWs   = logWb.Sheets[logWb.SheetNames[0]];
  const logRows = XLSX.utils.sheet_to_json(logWs, { header: 1 });
  const headers = logRows[0];

  const productIdx = headers.indexOf('Product');
  const uomIdx     = headers.indexOf('UoM');
  const taxIdx     = headers.indexOf('Tax incl.');
  const prIdx      = headers.indexOf('Purchase Number');
  const companyIdx = headers.indexOf('Company');

  const kept     = [headers];
  let   rejected = 0;

  logRows.slice(1).forEach(row => {
    if (!row.length) return;

    const productRaw = (row[productIdx] || '').toString();
    const uom        = (row[uomIdx]     || '').toString().trim();
    const taxIncl    = parseFloat(row[taxIdx]) || 0;
    const prNum      = row[prIdx] || '';
    const company    = (row[companyIdx] || '').toString();

    // Parse BU code from "[PSV:xxxxx]" format
    const buMatch = company.match(/\[([A-Z]+):/);
    const buCode  = buMatch ? buMatch[1] : '';

    // Parse item code from "[0000001234] Product name"
    const codeMatch = productRaw.match(/^\[(\d+)\]\s*(.+)/);
    if (!codeMatch) { kept.push(row); return; }
    const itemCode = codeMatch[1];
    const itemName = codeMatch[2].trim();

    // Look up by Item Code (col A), Description_254 (col B), or Tradename (col C)
    const found = minData.find(r =>
      r[0]?.toString().trim() === itemCode ||
      r[1]?.toString().trim().toLowerCase() === itemName.toLowerCase() ||
      r[2]?.toString().trim().toLowerCase() === itemName.toLowerCase()
    );

    if (!found) { kept.push(row); return; } // not in file = no minimum

    // BU = PSUV (BKK) → col K (index 10), all others → col L (index 11)
    const minColIdx = buCode === 'PSUV' ? 10 : 11;
    const minVal    = parseFloat(found[minColIdx]);

    if (!minVal) { kept.push(row); return; } // void = no minimum

    // UoM mismatch warning (don't reject, just warn)
    const fileUoM = (found[4] || '').toString().trim();
    if (fileUoM && fileUoM.toLowerCase() !== uom.toLowerCase()) {
      log(`UoM mismatch: ${prNum} | Log: "${uom}" | File: "${fileUoM}"`);
    }

    if (taxIncl >= minVal) {
      kept.push(row);
    } else {
      log(`REJECTED: ${prNum} | ${itemName} | Tax incl: ${taxIncl.toLocaleString()} | Min: ${minVal.toLocaleString()}`);
      rejected++;
    }
  });

  if (rejected > 0) {
    const newSheet = XLSX.utils.aoa_to_sheet(kept);
    logWb.Sheets[logWb.SheetNames[0]] = newSheet;
    XLSX.writeFile(logWb, logPath);
    log(`Removed ${rejected} row(s) from log that did not meet minimum order value`);
  } else {
    log('All items meet minimum order requirements');
  }
}

// ─── STEP 13: CLEANUP ────────────────────────────────────────────────────────
function cleanup(exportPath) {
  try {
    execSync(`del /f "${exportPath}"`, { stdio: 'ignore' });
    log(`Deleted export file: ${exportPath}`);
  } catch {}
}

// ─── EXPORTS (used by pr2po-operator.mjs) ────────────────────────────────────
export {
  findLogFile, findMinimumOrderFile,
  launchChrome, connectAndNavigate, selectDatabase,
  login, switchBU, navigateToPRtoPO,
  removeFilter, groupByBuyer, clickSupplyBuyer, exportXLSX,
  appendToLog, checkMinimumOrder, cleanup,
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  log('=== ODOO PR → PO Workflow Start ===');
  log(`Log file: ${LOG_FILE}`);

  await launchChrome();

  const { browser, page } = await connectAndNavigate();

  await selectDatabase(page);
  await login(page);
  await switchBU(page);
  await navigateToPRtoPO(page);
  await removeFilter(page);
  await groupByBuyer(page);
  await clickSupplyBuyer(page);

  const exportPath = await exportXLSX(page);
  await appendToLog(exportPath, LOG_FILE);
  await checkMinimumOrder(LOG_FILE);
  cleanup(exportPath);

  await browser.close();
  log('=== Done ===');
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
