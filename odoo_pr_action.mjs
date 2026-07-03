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

import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
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
  supply:   { buyer: 'SUPPLY_BUYER' },
  medicine: { buyer: 'MEDICINE_BUYER' },
};

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

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ─── STEP 1: LAUNCH & CONNECT ────────────────────────────────────────────────
async function connectAndNavigate() {
  log('Launching Chrome...');
  const browser = await chromium.launch({ headless: HEADLESS, channel: 'chrome' });
  const context = await browser.newContext();
  const page    = await context.newPage();
  return { browser, context, page };
}

// ─── STEP 2: SELECT DATABASE ──────────────────────────────────────────────────
async function selectDatabase(page) {
  log('Navigating to database selector...');
  await page.goto(DB_SELECTOR_URL);
  await page.waitForLoadState('networkidle');
  await page.click('a[href*="princ-smarterp-prod-base-"]');
  await page.waitForLoadState('load');
  log(`Database selected, URL: ${page.url()}`);
}

// ─── STEP 3: LOGIN ────────────────────────────────────────────────────────────
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

// ─── STEP 4: SWITCH BU ────────────────────────────────────────────────────────
async function switchBU(page) {
  log(`Switching BU to ${TARGET_BU_CODE}...`);
  await page.waitForSelector('.o_main_navbar', { timeout: 30000 });

  let switcherFound = false;
  try {
    await page.waitForSelector('.o_switch_company_menu', { timeout: 5000, state: 'attached' });
    switcherFound = true;
  } catch {}

  if (!switcherFound) {
    log('Company switcher not present — single-company mode, proceeding as-is');
    return;
  }

  await page.click('.o_switch_company_menu button');
  await page.waitForTimeout(1000);

  const companies = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.o_switch_company_menu [data-company-id]')).map(el => ({
      id: el.getAttribute('data-company-id'),
      label: el.querySelector('.company_label')?.textContent?.trim() || '',
    }))
  );

  const odooPrefix = BU_ODOO_PREFIX[TARGET_BU_CODE];
  const target = companies.find(c => c.label.startsWith(odooPrefix));
  if (!target) throw new Error(`BU "${TARGET_BU_CODE}" not found in company list`);

  log(`Found BU: ${target.label}`);
  await page.click(`[data-company-id="${target.id}"] .log_into`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  log(`Switched to ${TARGET_BU_CODE}`);
}

// ─── STEP 5: NAVIGATE TO GENERATE PR TO PO ───────────────────────────────────
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

// ─── STEP 6: REMOVE DEFAULT FILTER ───────────────────────────────────────────
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

// ─── STEP 7: GROUP BY BUYER ───────────────────────────────────────────────────
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

// ─── STEP 8: EXPAND BUYER GROUP ──────────────────────────────────────────────
async function expandBuyerGroup(page) {
  log(`Expanding ${TARGET_BUYER} group...`);
  await page.waitForTimeout(1500);

  if (await page.locator('.o_group_header').count() === 0) {
    throw new Error('No PR groups found — list is empty');
  }

  const target = page.locator('.o_group_header').filter({ hasText: TARGET_BUYER });
  if (await target.count() === 0) {
    throw new Error(`${TARGET_BUYER} group not found — no pending PRs`);
  }

  await target.first().click();
  await page.waitForTimeout(2000);
  log(`${TARGET_BUYER} expanded`);
}

// ─── STEP 9: FIND & SELECT THE TARGET PR ROW(S) ──────────────────────────────
// This list is per PR-LINE, not per-PR — a PR with multiple order lines shows
// one row per line, all sharing the same PR number. Validates every PR number
// resolves to at least one line row BEFORE checking any of them — a batch run
// either fully qualifies or aborts with nothing checked, never a partial check.
async function selectPRRows(page) {
  const matched = [];
  for (const prNumber of PR_NUMBERS) {
    log(`Finding line row(s) for PR ${prNumber}...`);
    const rows = page.locator('tr.o_data_row').filter({ hasText: prNumber });
    const count = await rows.count();
    if (count === 0) throw new Error(`PR "${prNumber}" not found in ${TARGET_BUYER} group — already processed, or wrong BU/profile? (nothing checked yet)`);

    const rowTexts = [];
    for (let i = 0; i < count; i++) {
      rowTexts.push((await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim());
    }
    log(`Matched ${count} line row(s) for PR ${prNumber}`);
    matched.push({ prNumber, rows, count, rowTexts });
  }

  for (const { prNumber, rows, count } of matched) {
    // Scoped to each matched row — NOT the header "select all" checkbox
    for (let i = 0; i < count; i++) {
      await rows.nth(i).locator('.o_list_record_selector.user-select-none > .o-checkbox').click();
      await page.waitForTimeout(300);
    }
    log(`Checked ${count} row(s) for PR ${prNumber}`);
  }

  return matched.map(({ prNumber, rowTexts }) => ({ prNumber, rowTexts }));
}

// ─── STEP 10: EXECUTE THE ACTION ─────────────────────────────────────────────
const ACTION_MENU_ITEM = {
  approve: 'Generate to PO',
  reject:  'Cancel PR',
};

// Cancel PR triggers a native browser confirm() dialog (unlike Generate to PO,
// which has none). Playwright auto-dismisses unhandled dialogs, which would
// silently no-op the cancellation — must explicitly accept it to take effect.
async function executeAction(page) {
  const menuItemName = ACTION_MENU_ITEM[ACTION];

  log('Opening Actions menu...');
  await page.click('.o_cp_action_menus button');
  await page.waitForTimeout(500);

  const item = page.locator('.o_cp_action_menus .dropdown-item').filter({ hasText: menuItemName });
  if (await item.count() === 0) throw new Error(`Menu item "${menuItemName}" not found in Actions dropdown`);

  if (TEST_MODE) {
    log(`[--test] Would click "${menuItemName}" now for ${PR_NUMBERS.length} PR(s) — skipping (no real Odoo action taken)`);
    await page.keyboard.press('Escape');
    return false;
  }

  if (ACTION === 'reject') {
    page.once('dialog', dialog => {
      log(`Confirming dialog: "${dialog.message()}"`);
      dialog.accept().catch(() => {});
    });
  }

  log(`Clicking "${menuItemName}" — THIS IS FINAL${ACTION === 'approve' ? ', no confirmation dialog in Odoo' : ''}...`);
  await item.first().click();
  await page.waitForTimeout(2000);
  log(`"${menuItemName}" executed`);
  return true;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n── PR Action ── ${ACTION.toUpperCase()} ${PR_NUMBERS.length} PR(s) [${PR_NUMBERS.join(', ')}] — Profile: ${PROFILE_KEY} | BU: ${TARGET_BU_CODE}${TEST_MODE ? ' | --test (dry run)' : ''}`);

  let browser;
  let result  = 'FAILED';
  let errorMsg = null;
  let matched  = [];

  try {
    const conn = await connectAndNavigate();
    browser = conn.browser;
    await selectDatabase(conn.page);
    await login(conn.page);
    await switchBU(conn.page);
    await navigateToPRtoPO(conn.page);
    await removeFilter(conn.page);
    await groupByBuyer(conn.page);
    await expandBuyerGroup(conn.page);
    matched = await selectPRRows(conn.page);
    const executed = await executeAction(conn.page);
    result = executed ? 'EXECUTED' : 'DRY-RUN';
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
