/**
 * Promote a manually-approved vendor to the reference sheet's "2nd tier
 * Vendor" column, so odoo_pr_to_po.mjs's vendor check accepts it
 * automatically next time this item shows up with this vendor. Called by
 * the procurement-operator agent when a leftover PR's vendor-mismatch
 * rejection is approved via odoo_pr_action.mjs (SKILL.md: "PR Action run
 * is EXECUTED (approve)" step) — never invoked for min-order rejections or
 * for reject actions.
 *
 * Usage: node promote_vendor_tier2.mjs <BU_CODE> <ITEM_CODE> <VENDOR_CODE> <VENDOR_NAME>
 *
 * Idempotent: if the vendor code is already present in the item's 2nd tier
 * Vendor cell, does nothing. Never creates a new reference row — if no
 * existing row matches <BU_CODE>|<ITEM_CODE>, it errors out rather than
 * silently inventing a row (adding an unreviewed item to the master list
 * is a bigger decision than promoting a vendor on an existing one).
 */

import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { REF_SHEET } from './lib/config.mjs';
import { loadEnv } from './lib/util.mjs';
import { appendDecision } from './lib/decision-log.mjs';
import { getSheetClient as getSheetClientBase, parseTier2Vendors } from './lib/sheets-client.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '.env'));

const GSHEETS_TOKEN_FILE = join(__dir, '.gsheets-token.json');

const [BU_CODE, ITEM_CODE, VENDOR_CODE, ...nameParts] = process.argv.slice(2);
const VENDOR_NAME = nameParts.join(' ').trim();
const USAGE = 'Usage: node promote_vendor_tier2.mjs <BU_CODE> <ITEM_CODE> <VENDOR_CODE> <VENDOR_NAME>';
if (!BU_CODE || !ITEM_CODE || !VENDOR_CODE || !VENDOR_NAME) throw new Error(USAGE);
// "|" is the 2nd tier Vendor list separator — a pipe inside a name would
// split into a phantom extra vendor entry on the next parse.
if (VENDOR_CODE.includes('|') || VENDOR_NAME.includes('|'))
  throw new Error('VENDOR_CODE / VENDOR_NAME must not contain "|" (reserved as the 2nd tier Vendor separator)');

// Never interactive here — this tool assumes odoo_pr_to_po.mjs already
// authorized once and saved the token.
const getSheetClient = () => getSheetClientBase({
  tokenFile: GSHEETS_TOKEN_FILE,
  missingTokenMsg: '.gsheets-token.json not found — run odoo_pr_to_po.mjs once to authorize',
});

// 0-indexed column → A1 letter(s). Single fromCharCode breaks past Z (idx 25);
// this stays correct if the read range ever widens beyond column Z.
function colToA1(idx) {
  let s = '';
  for (let n = idx + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

(async () => {
  const sheets = await getSheetClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: REF_SHEET.id });
  const tab = meta.data.sheets.find(s => String(s.properties.sheetId) === String(REF_SHEET.gid));
  if (!tab) throw new Error(`Tab with gid ${REF_SHEET.gid} not found in reference sheet`);
  const tabName = tab.properties.title;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: REF_SHEET.id,
    range: `'${tabName}'!A:P`,
  });
  const rows    = res.data.values || [];
  const headers = rows[0] || [];
  const buIdx    = headers.indexOf('bu');
  const itemIdx  = headers.indexOf('order_item_code');
  const tier2Idx = headers.indexOf('2nd tier Vendor');
  if (buIdx < 0 || itemIdx < 0 || tier2Idx < 0) throw new Error('Expected columns (bu, order_item_code, 2nd tier Vendor) not found in reference sheet header row');

  const rowIndex = rows.findIndex((r, i) => i > 0 && (r[buIdx] || '').trim() === BU_CODE && (r[itemIdx] || '').trim() === ITEM_CODE);
  if (rowIndex < 0) {
    console.log(`[SKIP] No reference row found for ${BU_CODE} | ${ITEM_CODE} — not promoting (won't create a new row)`);
    process.exit(1);
  }

  const existingRaw = rows[rowIndex][tier2Idx] || '';
  const existing = parseTier2Vendors(existingRaw);
  if (existing.some(v => v.code === VENDOR_CODE)) {
    console.log(`[NO-OP] Vendor code ${VENDOR_CODE} already present in 2nd tier Vendor for ${BU_CODE} | ${ITEM_CODE}`);
    return;
  }

  const newEntry   = `${VENDOR_CODE} ${VENDOR_NAME}`;
  const newValue   = existingRaw.trim() ? `${existingRaw.trim()} | ${newEntry}` : newEntry;
  const sheetRow   = rowIndex + 1; // rows[] is 0-indexed and includes the header, so this is the 1-indexed sheet row
  const colLetter  = colToA1(tier2Idx);

  await sheets.spreadsheets.values.update({
    spreadsheetId: REF_SHEET.id,
    range: `'${tabName}'!${colLetter}${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newValue]] },
  });

  console.log(`[PROMOTED] ${BU_CODE} | ${ITEM_CODE} — added "${newEntry}" to 2nd tier Vendor`);
  // Audit trail — the sheet write already happened, so a failed append must
  // warn, never fail the run.
  try {
    appendDecision({ event: 'TIER2-PROMOTE', bu: BU_CODE, detail: `${ITEM_CODE} += ${newEntry}` });
  } catch (e) {
    console.warn(`⚠ Decision Log append failed: ${e.message}`);
  }
})().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
