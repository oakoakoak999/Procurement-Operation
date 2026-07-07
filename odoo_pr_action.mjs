/**
 * ODOO Leftover-PR Action Tool
 * Approves (Generate to PO) or rejects (Cancel PR) one or more PRs left over
 * from odoo_pr_to_po.mjs's vendor/min-order validation, after daily human
 * review. Multiple PRs are checked in the same Odoo list and actioned with
 * ONE Actions click — Odoo processes only the checked rows.
 *
 * Usage:
 *   node odoo_pr_action.mjs <profile> <BU_CODE> <PR_NUMBER[,PR_NUMBER...]> approve [--test] [--headless]
 *   node odoo_pr_action.mjs <profile> <BU_CODE> <PR_NUMBER[,PR_NUMBER...]> reject  [--test] [--headless]
 *   node odoo_pr_action.mjs <profile> <BU_CODE> <approve|reject> --file=<path> [--test] [--headless]
 *
 * --file: read PR numbers from a text file instead of the CLI arg — one PR
 * number per line, blank lines and lines starting with # are ignored. Use
 * this for large batches instead of hand-typing a comma list.
 *
 * --test: runs the full flow (login, navigate, find each PR, check its row,
 * open Actions menu) but skips the final click. No real Odoo state change.
 *
 * WARNING: "Generate to PO" has no Odoo confirmation dialog — clicking it
 * immediately creates real POs for every checked row. "Cancel PR" does show
 * a confirm dialog, which this script auto-accepts. Neither action can be
 * undone from here. All PR numbers must be found before anything is
 * checked — if any one is missing, the whole run aborts with none acted on.
 */

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { selectPRRows, executeOdooAction } from './lib/pr-row-actions.mjs';
import { ODOO_URL, BU_ODOO_PREFIX } from './lib/config.mjs';
import { loadEnv, log } from './lib/util.mjs';
import { appendDecision } from './lib/decision-log.mjs';
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
  supply:   { buyer: 'SUPPLY_BUYER' },
  medicine: { buyer: 'MEDICINE_BUYER' },
};

const USAGE = 'Usage: node odoo_pr_action.mjs <profile> <BU_CODE> <PR_NUMBER[,PR_NUMBER...]> <approve|reject> [--test] [--headless]\n' +
              '   or: node odoo_pr_action.mjs <profile> <BU_CODE> <approve|reject> --file=<path> [--test] [--headless]';
const FILE_FLAG = process.argv.find(a => a.startsWith('--file='));
const _pos = process.argv.slice(2).filter(a => !a.startsWith('--'));

let PROFILE_KEY, TARGET_BU_CODE, PR_NUMBERS_ARG, ACTION;
if (FILE_FLAG) {
  [PROFILE_KEY, TARGET_BU_CODE, ACTION] = _pos;
} else {
  [PROFILE_KEY, TARGET_BU_CODE, PR_NUMBERS_ARG, ACTION] = _pos;
}
if (!PROFILE_KEY || !TARGET_BU_CODE || !ACTION || (!FILE_FLAG && !PR_NUMBERS_ARG)) throw new Error(USAGE);

let PR_NUMBERS;
if (FILE_FLAG) {
  const listPath = FILE_FLAG.slice('--file='.length);
  if (!existsSync(listPath)) throw new Error(`--file path not found: ${listPath}`);
  PR_NUMBERS = [...new Set(
    readFileSync(listPath, 'utf8').split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'))
  )];
} else {
  PR_NUMBERS = [...new Set(PR_NUMBERS_ARG.split(',').map(s => s.trim()).filter(Boolean))];
}
if (PR_NUMBERS.length === 0) throw new Error(USAGE);

const _prof = PROFILES[PROFILE_KEY];
if (!_prof) throw new Error(`Unknown profile "${PROFILE_KEY}". Valid: ${Object.keys(PROFILES).join(', ')}\n${USAGE}`);
if (!BU_ODOO_PREFIX[TARGET_BU_CODE]) throw new Error(`Unknown BU "${TARGET_BU_CODE}". Valid: ${Object.keys(BU_ODOO_PREFIX).join(', ')}`);
if (ACTION !== 'approve' && ACTION !== 'reject') throw new Error(`Unknown action "${ACTION}". Valid: approve | reject\n${USAGE}`);

const TARGET_BUYER = _prof.buyer;
const HEADLESS      = process.argv.includes('--headless');
const TEST_MODE     = process.argv.includes('--test');

// STEPS 1–8 (launch browser, select DB, login, switch BU, navigate to
// Generate PR to PO, remove filter, group by buyer, expand buyer group)
// live in ./lib/odoo-nav.mjs — shared with odoo_pr_to_po.mjs.
// STEP 9 (find & select target PR row(s)) and STEP 10 (execute the action)
// live in ./lib/pr-row-actions.mjs — shared with odoo_pr_to_po.mjs's --generate
// path so there's exactly one copy of the code that clicks an irreversible
// Odoo action.

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n── PR Action ── ${ACTION.toUpperCase()} ${PR_NUMBERS.length} PR(s) [${PR_NUMBERS.join(', ')}] — Profile: ${PROFILE_KEY} | BU: ${TARGET_BU_CODE}${TEST_MODE ? ' | --test (dry run)' : ''}`);

  let browser;
  let result  = 'FAILED';
  let errorMsg = null;
  let matched  = [];

  try {
    const conn = await connectAndNavigate({ headless: HEADLESS });
    browser = conn.browser;
    await selectDatabase(conn.page, ODOO_URL);
    await login(conn.page, { username: USERNAME, password: PASSWORD });
    await switchBU(conn.page, TARGET_BU_CODE, BU_ODOO_PREFIX);
    await navigateToPRtoPO(conn.page);
    await removeFilter(conn.page);
    await groupByBuyer(conn.page);
    // Here an absent group is an error, not an early exit — the requested PR
    // numbers are expected to exist in this list.
    if (!await expandBuyerGroup(conn.page, TARGET_BUYER))
      throw new Error(`${TARGET_BUYER} group not found or PR list is empty — no pending PRs`);
    matched = await selectPRRows(conn.page, PR_NUMBERS, TARGET_BUYER, log);
    const executed = await executeOdooAction(conn.page, ACTION, { testMode: TEST_MODE, log });
    result = executed ? 'EXECUTED' : 'DRY-RUN';
    // Audit trail — real executions only. The Odoo action already happened,
    // so a failed append must warn, never fail the run.
    if (executed) {
      try {
        for (const pr of PR_NUMBERS)
          appendDecision({ event: ACTION.toUpperCase(), profile: PROFILE_KEY, bu: TARGET_BU_CODE, detail: pr });
      } catch (e) {
        console.warn(`⚠ Decision Log append failed: ${e.message}`);
      }
    }
  } catch (err) {
    errorMsg = err.message;
    console.error(`\n❌ ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log(`\n[SUMMARY] ACTION: ${ACTION} | PRs: ${PR_NUMBERS.length} [${PR_NUMBERS.join(', ')}] | BU: ${TARGET_BU_CODE} | Profile: ${PROFILE_KEY} | Result: ${result}`);
    for (const { prNumber, rowTexts } of matched) {
      console.log(`  PR [${prNumber}] — ${rowTexts.length} line(s):`);
      for (const t of rowTexts) console.log(`    ${t}`);
    }
    if (errorMsg) console.log(`  Error: ${errorMsg}`);
    if (result === 'FAILED') process.exit(1);
  }
})();
