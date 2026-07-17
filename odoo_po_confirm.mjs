/**
 * Confirm PO — peer of odoo_pr_to_po.mjs, not a stage of it.
 *
 * Sets Expected Arrival (date_planned) = Order Deadline (date_order) + N working
 * days, then Confirms the RFQ. N comes from the profile: medicine 10, supply 15.
 * Working day = Mon-Fri; Thai public holidays are not excluded.
 *
 * Target selection is by the RFQ list's own columns — state must be RFQ and
 * buyer_id must match the profile's buyer. The BU's list mixes MEDICINE_BUYER,
 * SUPPLY_BUYER, EXPENSE_BUYER and LAB_BUYER together and is NOT filtered by
 * default (80 rows on PSUV UAT), so both filters are load-bearing: without them
 * this would walk into other teams' orders.
 *
 * Order Deadline must be read from the FORM, not the list — the list cell
 * renders it as relative text ("21 days ago").
 *
 * Dry-run by default: reads and reports, writes nothing. --confirm executes.
 * --test forces dry-run and overrides --confirm, so a workflow can pass the
 * explicit no-click flag and never fire a Confirm even if --confirm slips in.
 *
 * Usage: node odoo_po_confirm.mjs <profile> <BU_CODE> [--headless] [--test] [--confirm]
 */

import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { connectAndNavigate, selectDatabase, login, switchBU, navigateToRFQList } from './lib/odoo-nav.mjs';
import { parseOdooDate, addWorkingDays, formatDDMMYYYY, formatOdooDateTime, bangkokToday } from './lib/arrival-date.mjs';
import { ODOO_URL, BU_ODOO_PREFIX } from './lib/config.mjs';
import { loadEnv, log, makeRunId } from './lib/util.mjs';
import { appendConfirmLog } from './lib/execution-log.mjs';
import { syncMemoryFolder } from './lib/memory-sync.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '.env'));

const USERNAME = process.env.ODOO_USERNAME;
const PASSWORD = process.env.ODOO_PASSWORD;
if (!USERNAME || !PASSWORD) throw new Error('ODOO_USERNAME / ODOO_PASSWORD not set in .env');

const PROFILES = {
  supply:   { buyer: 'SUPPLY_BUYER',   workingDays: 15 },
  medicine: { buyer: 'MEDICINE_BUYER', workingDays: 10 },
};

const USAGE = 'Usage: node odoo_po_confirm.mjs <profile> <BU_CODE> [--headless] [--test] [--confirm]\nProfiles: supply | medicine';
const [PROFILE_KEY, TARGET_BU] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const HEADLESS = process.argv.includes('--headless');
const TEST     = process.argv.includes('--test');
// --test hard-overrides --confirm: an explicit dry-run must never click Confirm,
// even if both flags are present. Absence of --confirm is also dry-run.
const CONFIRM  = process.argv.includes('--confirm') && !TEST;

if (!PROFILE_KEY || !TARGET_BU) throw new Error(USAGE);
const CONFIG = PROFILES[PROFILE_KEY];
if (!CONFIG) throw new Error(`Unknown profile "${PROFILE_KEY}". ${USAGE}`);

const cell = async (row, field) => (await row.locator(`td[name="${field}"]`).innerText().catch(() => '')).trim();

// Reads Order Deadline off the open form and returns the computed arrival.
// Throws rather than guessing: a missing anchor must never silently become
// "today", which would write a plausible-looking wrong date onto a real PO.
async function computeArrival(page) {
  const el = page.locator('div[name="date_order"] input').first();
  if (await el.count() === 0) throw new Error('date_order input not found on form');
  const raw = await el.inputValue();
  const anchor  = parseOdooDate(raw);
  const arrival = addWorkingDays(anchor, CONFIG.workingDays);
  return { raw, anchor, arrival };
}

// date_planned is a wrapper div containing the input — input[name="date_planned"]
// does not exist. A sibling field named date_planned_div holds the same value, so
// the selector is anchored to the exact name to avoid hitting the wrong one.
async function setArrival(page, arrival) {
  const input = page.locator('div[name="date_planned"] input').first();
  if (await input.count() === 0) throw new Error('date_planned input not found on form');
  await input.click();
  await input.fill(formatOdooDateTime(arrival));
  await page.keyboard.press('Escape'); // dismiss the datepicker overlay
  await page.waitForTimeout(500);

  // Verify the field actually took the value before confirming. Odoo silently
  // reverts an unparsed datetime, which would otherwise confirm the old date.
  const got = await input.inputValue();
  if (!got.startsWith(formatDDMMYYYY(arrival))) {
    throw new Error(`date_planned did not take: wanted ${formatDDMMYYYY(arrival)}, field shows ${JSON.stringify(got)}`);
  }
}

async function confirmPO(page) {
  const btn = page.getByRole('button', { name: 'Confirm', exact: true }).first();
  if (await btn.count() === 0) throw new Error('Confirm button not present');
  await btn.click();
  await page.waitForTimeout(2500);
}

async function backToList(page) {
  await page.locator('.breadcrumb-item a, .o_back_button').first().click();
  await page.waitForSelector('tr.o_data_row', { timeout: 15000 });
  await page.waitForTimeout(1000);
}

// The RFQ list is unfiltered by default and returns exactly 80 rows — Odoo's
// page size, i.e. page 1 of an unknown number. Scoping it to the RFQ >> None
// favourite (state=RFQ, Doc Approve=None) collapses it to the handful that
// actually need confirming. Throws if the favourite is missing rather than
// falling back to the unscoped list: a silent fallback would confirm from an
// 80-row mixed list and quietly miss everything on page 2.
async function applyRFQFilter(page) {
  log('Applying "RFQ >> None" filter...');
  await page.click('.o_searchview_dropdown_toggler');
  await page.waitForTimeout(1000);
  const fav = page.locator('.dropdown-item, .o_menu_item').filter({ hasText: 'RFQ >> None' }).first();
  if (await fav.count() === 0) throw new Error('Favourite "RFQ >> None" not found — refusing to run against the unscoped list');
  await fav.click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  const facets = (await page.locator('.o_searchview_facet').allInnerTexts()).join(' ');
  if (!/RFQ/.test(facets)) throw new Error(`Filter did not apply — facets read ${JSON.stringify(facets)}`);
  log(`Filter applied: ${facets.replace(/\s+/g, ' ').trim()}`);
}

// Pagination is the difference between "confirmed all of them" and "confirmed
// the ones that happened to be on page 1". Refuse to guess.
async function assertSinglePage(page) {
  const txt = (await page.locator('.o_pager_counter, .o_pager').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const m = txt.match(/(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
  if (!m) { log(`Pager not parsed (${JSON.stringify(txt)}) — assuming single page`); return; }
  if (Number(m[2]) < Number(m[3])) throw new Error(`RFQ list spans multiple pages (${txt}) — refusing to run and silently skip the rest`);
  log(`Pager: ${txt} — single page`);
}

// Scans the current list for RFQs belonging to this profile's buyer.
async function findTargets(page) {
  const rows = page.locator('tr.o_data_row');
  const out = [];
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i);
    const [state, buyer, name, origin] = await Promise.all(
      ['state', 'buyer_id', 'name', 'origin'].map(f => cell(row, f))
    );
    if (state === 'RFQ' && buyer === CONFIG.buyer) out.push({ name, origin });
  }
  return out;
}

const RUN_ID = makeRunId();
const MODE   = CONFIRM ? 'live' : 'dry-run';

(async () => {
  console.log(`[OPERATOR] Confirm PO — RUN_ID: ${RUN_ID} | Profile: ${PROFILE_KEY.toUpperCase()} (${CONFIG.buyer}, +${CONFIG.workingDays} working days) | BU: ${TARGET_BU} | ${CONFIRM ? 'LIVE' : 'DRY-RUN'}`);

  const conn = await connectAndNavigate({ headless: HEADLESS });
  const { page } = conn;
  const done = [], skipped = [], failed = [];
  let leftover = null;
  let targetCount = 0;
  let runError = null;

  try {
    await selectDatabase(page, ODOO_URL);
    await login(page, { username: USERNAME, password: PASSWORD });
    const landedBU = await switchBU(page, TARGET_BU, BU_ODOO_PREFIX);
    log(`Landed BU: ${landedBU ?? 'null (no switcher)'}`);

    // A fresh login is not inside the Purchase app, and navigateToRFQList starts
    // by clicking Orders — which only exists once the app is open.
    await page.waitForSelector('.o_navbar_apps_menu button', { timeout: 30000 });
    await page.click('.o_navbar_apps_menu button');
    await page.waitForTimeout(1000);
    await page.click('a.o_app[href*="menu_id=340"]');
    await page.waitForTimeout(3000);

    await navigateToRFQList(page);
    await applyRFQFilter(page);
    await assertSinglePage(page);

    // Collect targets up front, then re-find each by PO number rather than row
    // index: confirming a PO drops it out of the filtered list, so any cached
    // index would point at the wrong record on the next pass.
    const targets = await findTargets(page);
    targetCount = targets.length;

    log(`${targets.length} RFQ(s) for ${CONFIG.buyer} in ${TARGET_BU}`);
    if (targets.length === 0) { log('Nothing to confirm'); return; }

    for (const t of targets) {
      try {
        await page.getByRole('cell', { name: t.name, exact: true }).first().click();
        await page.waitForTimeout(2000);

        const { raw, anchor, arrival } = await computeArrival(page);
        const stale = arrival < bangkokToday();
        const line = `${t.name} (PR ${t.origin}): deadline ${formatDDMMYYYY(anchor)} +${CONFIG.workingDays}wd -> arrival ${formatDDMMYYYY(arrival)}${stale ? '  [PAST]' : ''}`;

        if (!CONFIRM) {
          log(`DRY-RUN  ${line}  (raw anchor ${JSON.stringify(raw)})`);
          skipped.push(line);
        } else {
          await setArrival(page, arrival);
          await confirmPO(page);
          log(`CONFIRMED  ${line}`);
          done.push(line);
        }
        await backToList(page);
      } catch (err) {
        // Per-PO isolation: one bad record must not strand the rest. The failure
        // is reported, never swallowed into a clean exit.
        log(`FAILED  ${t.name}: ${err.message.split('\n')[0]}`);
        failed.push(`${t.name}: ${err.message.split('\n')[0]}`);
        await backToList(page).catch(() => {});
      }
    }

    // Completion proof: re-scan the filtered list. A confirmed PO leaves RFQ
    // state and drops out, so anything still listed was NOT confirmed. Without
    // this the run reports "3 confirmed" and exits clean while POs sit pending.
    if (CONFIRM) {
      const left = await findTargets(page);
      leftover = left.map(l => l.name);
      const unexplained = leftover.filter(n => !failed.some(f => f.startsWith(n)));
      if (unexplained.length) log(`WARNING: still pending and not accounted for by a failure: ${unexplained.join(', ')}`);
      else if (leftover.length === 0) log('Verified: no RFQs remain for this buyer');
    }
  } catch (err) {
    // A fatal error (login, navigation, filter refusing to apply) still gets
    // logged in the finally — an aborted run is exactly the kind of execution
    // that must leave a trace.
    runError = err.message.split('\n')[0];
    throw err;
  } finally {
    console.log('\n════ SUMMARY ════');
    console.log(`Mode      : ${CONFIRM ? 'LIVE (--confirm)' : 'DRY-RUN — nothing written'}`);
    console.log(`Confirmed : ${done.length}`);
    console.log(`Would do  : ${skipped.length}`);
    console.log(`Failed    : ${failed.length}`);
    if (leftover !== null) console.log(`Still RFQ : ${leftover.length}${leftover.length ? ` (${leftover.join(', ')})` : ' — all done'}`);
    for (const f of failed) console.log(`  FAIL  ${f}`);

    // Standing rule: every execution logs, dry-run included. Wrapped so a
    // logging problem can't mask the run's real outcome.
    try {
      const logFile = appendConfirmLog({
        runId: RUN_ID, mode: MODE, profile: PROFILE_KEY, bu: TARGET_BU,
        targets: targetCount, done, planned: skipped, failed,
        stillRFQ: leftover, error: runError,
      }, __dir);
      log(`Execution logged → ${logFile}`);
      syncMemoryFolder(`Confirm-PO ${PROFILE_KEY} ${TARGET_BU} (${RUN_ID}) [${MODE}] memory sync`);
    } catch (e) {
      log(`WARNING: could not write execution log: ${e.message.split('\n')[0]}`);
    }

    await conn.browser.close().catch(() => {});
    if (failed.length || runError) process.exitCode = 1;
  }
})();
