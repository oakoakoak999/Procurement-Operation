// Loads and validates config.json (git-ignored — copy config.json.example to create it).
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

if (!existsSync(CONFIG_PATH)) {
  throw new Error(`config.json not found at ${CONFIG_PATH} — copy config.json.example and fill in real values.`);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

for (const key of ['odooUrl', 'refSheet', 'buOdooPrefix', 'buLogSheets', 'buOrderFolders']) {
  if (!config[key]) throw new Error(`config.json missing required key: ${key}`);
}
if (!config.refSheet.id || !config.refSheet.gid) {
  throw new Error('config.json refSheet must have id and gid');
}

// BUs that must never be processed by any pipeline, on any machine. Hardcoded
// HERE, not in config.json: config.json is git-ignored and per-machine, so an
// exclusion kept only there silently fails to hold on a cloud runner or a second
// PC — and an exclusion kept only in an operator's memory doesn't run at all when
// the pipeline runs unattended. This module is the single chokepoint every entry
// point imports its BU maps from, so stripping here fails closed everywhere:
// run-batch won't enumerate a blocked BU, `--bu=KBKJ` is rejected as unknown, and
// any BU_*[code] lookup in the single-run scripts misses and throws.
const BLOCKED_BUS = new Set(['KBKJ']);

function stripBlocked(map) {
  return Object.fromEntries(Object.entries(map).filter(([bu]) => !BLOCKED_BUS.has(bu)));
}

// Warn (once) if this machine's config still lists a blocked BU — the block held,
// but the config should be cleaned up so the two don't disagree.
const present = Object.keys(config.buOdooPrefix).filter(bu => BLOCKED_BUS.has(bu));
if (present.length) console.warn(`⚠ config.json lists blocked BU(s) [${present.join(', ')}] — excluded by policy in lib/config.mjs; remove from config.json to silence this.`);

const buOdooPrefix   = stripBlocked(config.buOdooPrefix);
const buLogSheets    = stripBlocked(config.buLogSheets);
const buOrderFolders = stripBlocked(config.buOrderFolders);

// Every BU with an Odoo prefix must have a log sheet; order folders may lag behind.
for (const bu of Object.keys(buOdooPrefix)) {
  if (!buLogSheets[bu]) throw new Error(`config.json: BU ${bu} has odoo prefix but no log sheet id`);
}

// Auto-select the door: GitHub Actions sets GITHUB_ACTIONS=true on every runner,
// so a runner uses the gha URL (if provided) and a human PC uses the normal URL.
// Falls back to odooUrl when odooUrlGha is absent — backward compatible.
const onRunner = process.env.GITHUB_ACTIONS === 'true';
export const ODOO_URL         = onRunner && config.odooUrlGha ? config.odooUrlGha : config.odooUrl;
export const REF_SHEET        = config.refSheet;
export const BU_ODOO_PREFIX   = buOdooPrefix;
export const BU_LOG_SHEETS    = buLogSheets;
export const BU_ORDER_FOLDERS = buOrderFolders;
export default config;
