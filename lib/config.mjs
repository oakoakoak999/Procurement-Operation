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

// Every BU with an Odoo prefix must have a log sheet; order folders may lag behind.
for (const bu of Object.keys(config.buOdooPrefix)) {
  if (!config.buLogSheets[bu]) throw new Error(`config.json: BU ${bu} has odoo prefix but no log sheet id`);
}

// Auto-select the door: GitHub Actions sets GITHUB_ACTIONS=true on every runner,
// so a runner uses the gha URL (if provided) and a human PC uses the normal URL.
// Falls back to odooUrl when odooUrlGha is absent — backward compatible.
const onRunner = process.env.GITHUB_ACTIONS === 'true';
export const ODOO_URL         = onRunner && config.odooUrlGha ? config.odooUrlGha : config.odooUrl;
export const REF_SHEET        = config.refSheet;
export const BU_ODOO_PREFIX   = config.buOdooPrefix;
export const BU_LOG_SHEETS    = config.buLogSheets;
export const BU_ORDER_FOLDERS = config.buOrderFolders;
export default config;
