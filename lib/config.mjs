// Loads and validates config.json (git-ignored — copy config.json.example to create it).
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

if (!existsSync(CONFIG_PATH)) {
  throw new Error(`config.json not found at ${CONFIG_PATH} — copy config.json.example and fill in real values.`);
}

// Strip a leading BOM before parsing. Windows editors and PowerShell's
// `Out-File -Encoding utf8` both write one, and JSON.parse rejects it with an
// "Unexpected token" that points at character 1 and explains nothing.
const raw    = readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);

for (const key of ['odooUrl', 'refSheet', 'buOdooPrefix', 'buLogSheets', 'buOrderFolders']) {
  if (!config[key]) throw new Error(`config.json missing required key: ${key}`);
}
if (!config.refSheet.id || !config.refSheet.gid) {
  throw new Error('config.json refSheet must have id and gid');
}

// BUs that must never be processed by any pipeline, on any machine. KBKJ is a
// standing business exclusion (Oak, 2026-07: not processing it for the
// foreseeable future) — this is the source of truth for that decision.
//
// Hardcoded HERE, not in config.json: config.json is git-ignored and per-machine,
// so an exclusion kept only there silently fails to hold on a cloud runner or a
// second PC — and an exclusion kept only in an operator's memory doesn't run at
// all when the pipeline runs unattended. This module is the single chokepoint
// every entry point imports its BU maps from, so stripping here fails closed
// everywhere: run-batch won't enumerate a blocked BU, `--bu=KBKJ` is rejected as
// unknown, and any BU_*[code] lookup in the single-run scripts misses and throws.
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

// Which SmartERP to talk to. Read from argv as well as the environment because
// ESM imports are hoisted: a script cannot set process.env.ODOO_ENV in its own
// body and have this module see it, so the flag has to be parsed here.
//
// The default is uat, and it stays uat: production has to be an explicit choice
// every single time, never something you arrive at by forgetting a flag.
function readEnvFlag() {
  const argv = process.argv;
  const inline = argv.find(a => a.startsWith('--env='));
  if (inline) return inline.slice('--env='.length);
  const i = argv.indexOf('--env');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : '';
}

const rawEnv = (readEnvFlag() || process.env.ODOO_ENV || 'uat').toLowerCase();
if (rawEnv !== 'uat' && rawEnv !== 'prod') {
  throw new Error(`unknown environment "${rawEnv}" — use uat or prod`);
}
export const ODOO_ENV = rawEnv;

// Only the PO-daily pipeline is cleared for production. Everything else writes
// to Odoo — PR2PO creates POs, Confirm-PO confirms them, PR-action approves and
// rejects — and a stray --env prod on any of those would be doing it for real.
// They call this at startup so the refusal happens before a browser opens.
export function requireUat(who) {
  if (ODOO_ENV !== 'uat') {
    throw new Error(
      `${who} may not run against ${ODOO_ENV}. Only the PO-daily pipeline is ` +
      `cleared for production; it reads and prints, it does not write to Odoo.`
    );
  }
}

// Auto-select the door: GitHub Actions sets GITHUB_ACTIONS=true on every runner.
// The gha hosts exist solely so a runner can get in through Cloudflare, which
// blocks datacenter IPs at the normal hosts — so a runner takes the gha door and
// a human PC takes the normal one. Each environment has both doors. A missing gha
// host falls back to that environment's normal host, which keeps older configs
// working; on a runner that fallback will be Cloudflare-blocked, and the failure
// says so more usefully than a config error would.
const onRunner  = process.env.GITHUB_ACTIONS === 'true';
const directUrl = ODOO_ENV === 'prod' ? config.odooUrlProd    : config.odooUrl;
const ghaUrl    = ODOO_ENV === 'prod' ? config.odooUrlGhaProd : config.odooUrlGha;

export const ODOO_URL = onRunner && ghaUrl ? ghaUrl : directUrl;

if (!ODOO_URL) {
  const key = ODOO_ENV === 'prod' ? 'odooUrlProd' : 'odooUrl';
  throw new Error(`config.json missing ${key} — required for --env ${ODOO_ENV}`);
}

// Credentials split by environment the same way the URLs and the Cloudflare
// tokens do: UAT is the unsuffixed pair, production adds _PROD. Nothing falls
// back between them — UAT credentials reaching production (or the reverse) is
// the exact mix-up this split exists to prevent, so a missing pair throws.
//
// A function, not a constant: callers load .env in their own body, and ESM
// hoists this module's evaluation above that, so process.env is still empty
// when the lines above run. Call this after loadEnv().
export function odooCredentials() {
  const suffix   = ODOO_ENV === 'prod' ? '_PROD' : '';
  const username = process.env[`ODOO_USERNAME${suffix}`];
  const password = process.env[`ODOO_PASSWORD${suffix}`];
  if (!username || !password) {
    throw new Error(
      `ODOO_USERNAME${suffix} / ODOO_PASSWORD${suffix} not set in .env — required for --env ${ODOO_ENV}`
    );
  }
  return { username, password };
}
export const REF_SHEET        = config.refSheet;
export const BU_ODOO_PREFIX   = buOdooPrefix;
export const BU_LOG_SHEETS    = buLogSheets;
export const BU_ORDER_FOLDERS = buOrderFolders;
export default config;
