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

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '.env');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

const GSHEET_REF_ID      = '1HaJt0f0qVnY2vFs193ZVXdI5xhenKMTYkr-TZcj3Rzo';
const GSHEET_REF_GID     = 139595673;
const GSHEETS_TOKEN_FILE = join(__dir, '.gsheets-token.json');

const [BU_CODE, ITEM_CODE, VENDOR_CODE, ...nameParts] = process.argv.slice(2);
const VENDOR_NAME = nameParts.join(' ').trim();
const USAGE = 'Usage: node promote_vendor_tier2.mjs <BU_CODE> <ITEM_CODE> <VENDOR_CODE> <VENDOR_NAME>';
if (!BU_CODE || !ITEM_CODE || !VENDOR_CODE || !VENDOR_NAME) throw new Error(USAGE);

async function getSheetClient() {
  const { google } = await import('googleapis');
  const { GDRIVE_CLIENT_ID: clientId, GDRIVE_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) throw new Error('GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET not set in .env');
  if (!existsSync(GSHEETS_TOKEN_FILE)) throw new Error('.gsheets-token.json not found — run odoo_pr_to_po.mjs once to authorize');

  const auth = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/callback');
  auth.setCredentials(JSON.parse(readFileSync(GSHEETS_TOKEN_FILE, 'utf8')));
  return google.sheets({ version: 'v4', auth });
}

// Same "|"-separated "<code> <name>" format as odoo_pr_to_po.mjs's parseTier2Vendors.
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

(async () => {
  const sheets = await getSheetClient();

  const meta = await sheets.spreadsheets.get({ spreadsheetId: GSHEET_REF_ID });
  const tab = meta.data.sheets.find(s => s.properties.sheetId === GSHEET_REF_GID);
  if (!tab) throw new Error(`Tab with gid ${GSHEET_REF_GID} not found in reference sheet`);
  const tabName = tab.properties.title;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GSHEET_REF_ID,
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
  const colLetter  = String.fromCharCode('A'.charCodeAt(0) + tier2Idx);

  await sheets.spreadsheets.values.update({
    spreadsheetId: GSHEET_REF_ID,
    range: `'${tabName}'!${colLetter}${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newValue]] },
  });

  console.log(`[PROMOTED] ${BU_CODE} | ${ITEM_CODE} — added "${newEntry}" to 2nd tier Vendor`);
})().catch(err => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
