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
 *
 * Usage: node odoo_po_confirm.mjs <profile> <BU_CODE> [--headless] [--confirm]
 */

import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { connectAndNavigate, selectDatabase, login, switchBU, navigateToRFQList } from './lib/odoo-nav.mjs';
import { parseOdooDate, addWorkingDays, formatDDMMYYYY, formatOdooDateTime, bangkokToday } from './lib/arrival-date.mjs';
import { ODOO_URL, BU_ODOO_PREFIX } from './lib/config.mjs';
import { loadEnv, log } from './lib/util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '.env'));

const USERNAME = process.env.ODOO_USERNAME;
const PASSWORD = process.env.ODOO_PASSWORD;
if (!USERNAME || !PASSWORD) throw new Error('ODOO_USERNAME / ODOO_PASSWORD not set in .env');

const PROFILES = {
  supply:   { buyer: 'SUPPLY_BUYER',   workingDays: 15 },
  medicine: { buyer: 'MEDICINE_BUYER', workingDays: 10 },
};

const USAGE = 'Usage: node odoo_po_confirm.mjs <profile> <BU_CODE> [--headless] [--confirm]\nProfiles: supply | medicine';
const [PROFILE_KEY, TARGET_BU] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const HEADLESS = process.argv.includes('--headless');
const CONFIRM  = process.argv.includes('--confirm');

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

(async () => {
  console.log(`[OPERATOR] Confirm PO — Profile: ${PROFILE_KEY.toUpperCase()} (${CONFIG.buyer}, +${CONFIG.workingDays} working days) | BU: ${TARGET_BU} | ${CONFIRM ? 'LIVE' : 'DRY-RUN'}`);

  const conn = await connectAndNavigate({ headless: HEADLESS });
  const { page } = conn;
  const done = [], skipped = [], failed = [];

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

    // Collect targets up front: the row list goes stale once we start opening
    // records, and a confirmed PO drops out of RFQ state and reorders the list.
    const rows = page.locator('tr.o_data_row');
    const targets = [];
    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      const [state, buyer, name, origin] = await Promise.all(
        ['state', 'buyer_id', 'name', 'origin'].map(f => cell(row, f))
      );
      if (state === 'RFQ' && buyer === CONFIG.buyer) targets.push({ name, origin });
    }

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
  } finally {
    console.log('\n════ SUMMARY ════');
    console.log(`Mode      : ${CONFIRM ? 'LIVE (--confirm)' : 'DRY-RUN — nothing written'}`);
    console.log(`Confirmed : ${done.length}`);
    console.log(`Would do  : ${skipped.length}`);
    console.log(`Failed    : ${failed.length}`);
    for (const f of failed) console.log(`  FAIL  ${f}`);
    await conn.browser.close().catch(() => {});
    if (failed.length) process.exitCode = 1;
  }
})();
