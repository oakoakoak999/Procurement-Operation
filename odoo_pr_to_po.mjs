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

import XLSX from 'xlsx';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { selectPRRows, executeOdooAction, resetSelection } from './lib/pr-row-actions.mjs';
import { ODOO_URL, REF_SHEET, BU_ODOO_PREFIX, BU_LOG_SHEETS } from './lib/config.mjs';
import { loadEnv, log, makeRunId } from './lib/util.mjs';
import { getSheetClient as getSheetClientBase, parseTier2Vendors } from './lib/sheets-client.mjs';
import {
  connectAndNavigate, selectDatabase, login, switchBU,
  navigateToPRtoPO, removeFilter, groupByBuyer, expandBuyerGroup,
} from './lib/odoo-nav.mjs';

// ─── LOAD .env ────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '.env'));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
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

// Inverse map: '[PLPN:00059]' → 'PLPN1' — distinguishes BUs sharing the same letters
const PREFIX_TO_BU = Object.fromEntries(
  Object.entries(BU_ODOO_PREFIX).map(([code, prefix]) => [prefix, code])
);
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
const GSHEET_LOG_ID  = BU_LOG_SHEETS[TARGET_BU_CODE] ?? (() => { throw new Error(`No log sheet configured for BU "${TARGET_BU_CODE}"`); })();
const GSHEET_LOG_TAB      = _prof.logTab;
const CONFIG              = { profileKey: PROFILE_KEY, bu: TARGET_BU_CODE, buyer: TARGET_BUYER, logTab: GSHEET_LOG_TAB };
const GSHEET_EXEC_TAB     = 'Execute Log';
const GSHEETS_TOKEN_FILE  = join(__dir, '.gsheets-token.json');

// Column name overrides: source header → dest header (when names differ)
const COL_NAME_OVERRIDES = {
  'cancel reason': 'cancel',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Fetches the vendor + min-order reference rows via the authenticated Sheets
// API (replaced the public CSV export, which corrupted rows on quoted fields
// containing newlines and needed no auth to read procurement data).
async function fetchRefRows() {
  const sheets = await getSheetClient();

  // Resolve gid → tab title (gid survives a tab rename; a hardcoded title wouldn't)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: REF_SHEET.id, fields: 'sheets.properties' });
  const tab  = meta.data.sheets.find(s => String(s.properties.sheetId) === String(REF_SHEET.gid));
  if (!tab) throw new Error(`Tab with gid ${REF_SHEET.gid} not found in reference sheet`);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REF_SHEET.id,
    range: `'${tab.properties.title}'!A:Z`,
  });
  const allRows = res.data.values || [];
  const headers = (allRows[0] || []).map(h => String(h ?? '').trim());

  // A restructured or wrong tab would yield junk headers, every refMap lookup
  // would miss, and validation would silently pass EVERYTHING (fail-open —
  // --generate would act on it). Verify the response actually looks like the
  // reference sheet; throwing here lands in validateAndAppend's existing
  // catch → WARN + unvalidated append + no generation (fail-closed).
  const required = ['bu', 'order_item_code', 'Vendor Code', 'Vendor Name', 'Minimum Order'];
  const missing  = required.filter(h => !headers.includes(h));
  if (missing.length)
    throw new Error(`Reference sheet response is missing column(s) [${missing.join(', ')}] — sheet access restricted, or headers renamed?`);

  const rows = allRows.slice(1).map(vals => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = String(vals[i] ?? '').trim());
    return obj;
  });
  if (rows.length === 0) throw new Error('Reference sheet returned zero data rows — tab cleared?');
  return rows;
}

// Row order must match the Execute Log tab's headers (A→N). New columns are
// appended at the end, never inserted mid-row, so historical rows' existing
// columns don't shift.
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

// Interactive OAuth needs a human — in headless (cron) mode the shared client
// fails fast instead of hanging forever on a localhost callback no one will
// ever complete (the hang would also never write a FAILED Execute Log row).
const getSheetClient = () => getSheetClientBase({
  tokenFile: GSHEETS_TOKEN_FILE,
  interactive: !HEADLESS,
  missingTokenMsg: `Google Sheets token missing (${GSHEETS_TOKEN_FILE}) — run once without --headless to authorize`,
});

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

// Resolve BU code from a Company cell like "[PLPN:00059] Princ Lampang ..."
// Falls back to the letters inside brackets if the full prefix isn't in the map.
function buFromCompany(company) {
  const prefix = company.match(/^\[[A-Z]+:\d+\]/)?.[0];
  return (prefix && PREFIX_TO_BU[prefix]) || company.match(/\[([A-Z]+):/)?.[1] || '';
}

// STEPS 1–8 (launch browser, select DB, login, switch BU, navigate to
// Generate PR to PO, remove filter, group by buyer, expand buyer group)
// live in ./lib/odoo-nav.mjs — shared with odoo_pr_action.mjs.

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

  // Intercept the export response via network route. BU + profile + RUN_ID in
  // the filename so concurrent runs (multi-BU cron) can't overwrite each
  // other's export and validate/append another BU's rows.
  const filePath = `${DOWNLOAD_PATH}\\odoo_export_${TARGET_BU_CODE}_${PROFILE_KEY}_${RUN_ID}.xlsx`;
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

  // Close the export dialog and VERIFY it's gone. The route interception
  // fulfills the export request with a fake response, so Odoo never
  // auto-dismisses the dialog — and a lingering modal intercepts every later
  // page click. Caught live 20260706-1453: --generate's resetSelection timed
  // out behind this modal. Fail loud here (checkpoint B retries) rather than
  // in step 13 (deliberately unretried).
  const dialog = page.locator('.o_export_data_dialog');
  if (await dialog.isVisible()) {
    await page.keyboard.press('Escape');
    try {
      await dialog.waitFor({ state: 'hidden', timeout: 3000 });
    } catch {
      log('Escape did not close export dialog — clicking close button...');
      await page.locator('.o_export_data_dialog').locator('.btn-close, button[aria-label="Close"]').first().click();
      await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    }
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
    // Raw values, not display strings: the log's 0.00 format rounds prices to
    // 2dp, which never matches full-precision export values in the dedup key.
    valueRenderOption: 'UNFORMATTED_VALUE',
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
  // Without this column, dedup keys and --generate's PR grouping both silently
  // break (every row would key/group on "") — fail loudly instead.
  if (prNumIdx < 0) throw new Error(`Log tab "${GSHEET_LOG_TAB}" has no "Purchase Number" header column`);

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
  if (srcPrIdx < 0) throw new Error('Export file has no "Purchase Number" column — Odoo export template changed?');

  const newRows = [];
  srcData.forEach(srcRow => {
    const srcPrNum = normStr(srcRow[srcPrIdx]);
    // A blank PR number can't dedup (blank-PR log rows are excluded from
    // existingKeys) and would group as "" in validation — where the empty-PR
    // guard in selectPRRows would then abort the whole --generate batch.
    if (!srcPrNum) {
      log(`Skipping row with blank Purchase Number: ${normStr(srcRow[srcProductIdx]) || '(no product)'}`);
      return;
    }
    const rowKey = `${srcPrNum}|${normStr(srcRow[srcProductIdx])}|${normNum(srcRow[srcQtyIdx])}|${normNum(srcRow[srcUnitPriceIdx])}`;
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
    refRows = await fetchRefRows();
  } catch (e) {
    log(`WARNING: Could not fetch reference GSheet (${e.message}) — appending all rows without validation`);
    // --test writes NOTHING to the dedup log: a dry-run row would poison the
    // dedup key and make a later real run skip that PR (a silently missing PO).
    if (!TEST_MODE) {
      const sheets = await getSheetClient();
      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId: GSHEET_LOG_ID, range: GSHEET_LOG_TAB,
        valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: newRows },
      });
      await tryFixFormatting(sheets, appendRes, headers);
    } else {
      log(`TEST: skipped log-sheet append of ${newRows.length} unvalidated row(s)`);
    }
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
  // Structured (not display-text) rejection detail, for Memory.md's Pending
  // Leftover PRs table — kept separate from rejReason below so that string's
  // wording can change without breaking the memory writer's parsing.
  const pendingDetails   = [];

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
        vt.minRequired = Math.max(vt.minRequired, ...refs.map(r => parseFloat(String(r['Minimum Order'] ?? '').replace(/,/g, '')) || 0));
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

  // Append only passing rows — but never under --test (a dry-run row poisons the
  // dedup key so a later real run skips that PR, silently dropping its PO).
  if (passingRows.length > 0 && !TEST_MODE) {
    const sheets = await getSheetClient();
    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_LOG_ID, range: GSHEET_LOG_TAB,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: passingRows },
    });
    await tryFixFormatting(sheets, appendRes, headers);
  }

  const totalRejected = rejectedItems.length;
  log(`${TEST_MODE ? 'Would append (TEST — not written)' : 'Appended'} ${passingRows.length} row(s). Rejected ${totalRejected} PR(s).`);
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

  // Any modal left open by an earlier step intercepts every click below,
  // and this step deliberately has no retry — abort loud instead of timing
  // out row-by-row against an invisible wall.
  const openModal = page.locator('.modal.d-block');
  if (await openModal.count() > 0)
    throw new Error('A modal dialog is still open on the page — refusing to start row selection (nothing clicked)');

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

const RUN_ID = makeRunId();

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
    step('1/12 connectAndNavigate'); const conn = await connectAndNavigate({ headless: HEADLESS });
    step('2/12 selectDatabase');
    try {
      await selectDatabase(conn.page, ODOO_URL);
    } catch (err) {
      await conn.browser.close().catch(() => {}); // don't leak browsers across retries
      throw err;
    }
    return conn;
  });
}

async function checkpointB(page) {
  return withRetry('B: login + BU', async () => {
    step('3/12 login');            await login(page, { username: USERNAME, password: PASSWORD });
    step('4/12 switchBU');         await switchBU(page, TARGET_BU_CODE, BU_ODOO_PREFIX);
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
    step('8/12 expandBuyerGroup');
    const hasData = await expandBuyerGroup(page, TARGET_BUYER);
    if (!hasData) {
      throw new EarlyExit(`No ${CONFIG.buyer} PRs found — nothing to process`, '8/12 expandBuyerGroup');
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
  let exportPaths;
  try {
    conn = await checkpointA();
    await checkpointB(conn.page);
    exportPaths = await checkpointC(conn.page);
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
    // Belt-and-braces: if checkpoint D failed before its own cleanup, don't
    // leave the exported procurement data sitting in Downloads (ENOENT-safe
    // no-op when cleanup already ran).
    if (exportPaths) cleanup(exportPaths);
    // Machine-readable result for run-batch.mjs — the batch summary reads this
    // instead of regex-matching console text.
    if (process.env.PR2PO_RESULT_FILE) {
      try {
        writeFileSync(process.env.PR2PO_RESULT_FILE, JSON.stringify({
          ...runStats,
          bu: CONFIG.bu, profile: CONFIG.profileKey, testMode: TEST_MODE,
          generateMatched: runStats.generateMatched.map(m => m.prNumber),
        }, null, 2));
      } catch (e) {
        console.warn(`⚠ Result file write failed: ${e.message}`);
      }
    }
    await Promise.all([
      conn?.browser ? conn.browser.close().catch(() => {}) : Promise.resolve(),
      writeExecuteLog(runStats),
    ]);
    if (runStats.status === 'FAILED') process.exit(1);
  }
})();
