/**
 * Opens a pre-authenticated Playwright recording session on the Purchase Orders
 * list, so the "Add Custom Filter" dialog can be recorded by hand instead of
 * guessed at. Reuses the pipeline's own login path, so no credentials are typed
 * into codegen and none appear in the recorded output.
 *
 * Lands on a CLEAN search view (no group-bys applied) — the custom-filter dialog
 * is the same either way, and a clean bar makes the recorded selectors easier to
 * read. Apply group-bys by hand first if you want to see them interact.
 *
 * Read-only by intent: this script itself clicks nothing past navigation. What
 * happens after the pause is whatever the human does.
 *
 * Usage: node tools/codegen-po-filter.mjs [BU_CODE]
 * Example: node tools/codegen-po-filter.mjs PSNK
 */

import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { connectAndNavigate, selectDatabase, login, switchBU } from '../lib/odoo-nav.mjs';
import { ODOO_URL, BU_ODOO_PREFIX } from '../lib/config.mjs';
import { loadEnv, log } from '../lib/util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '..', '.env'));

const USERNAME = process.env.ODOO_USERNAME;
const PASSWORD = process.env.ODOO_PASSWORD;
if (!USERNAME || !PASSWORD) throw new Error('ODOO_USERNAME / ODOO_PASSWORD not set in .env');

const BU = process.argv[2] || 'PSNK';

(async () => {
  const conn = await connectAndNavigate({ headless: false });
  const { page } = conn;
  try {
    await selectDatabase(page, ODOO_URL);
    await login(page, { username: USERNAME, password: PASSWORD });

    const landedBU = await switchBU(page, BU, BU_ODOO_PREFIX);
    log(`BU: ${landedBU ?? `${BU} (no switcher — session BU unchanged)`}`);

    log('Navigating to Purchase Orders...');
    await page.waitForSelector('.o_navbar_apps_menu button');
    await page.click('.o_navbar_apps_menu button');
    await page.waitForSelector('a.o_app[href*="menu_id=340"]');
    await page.click('a.o_app[href*="menu_id=340"]');
    await page.waitForSelector('.o_menu_sections');
    await page.locator('.o_menu_sections button').filter({ hasText: 'Orders' }).click();
    await page.locator('.dropdown-item').filter({ hasText: 'Purchase Orders' }).first().waitFor();
    await page.locator('.dropdown-item').filter({ hasText: 'Purchase Orders' }).first().click();
    await page.waitForSelector('.o_searchview');

    console.log(`
════════════════════════════════════════════════════════════════
  READY — Playwright Inspector is opening.

  1. Click  ● Record  in the Inspector window.
  2. In Chrome: search-bar dropdown arrow  ▾
                → "Add Custom Filter"
                → field   = PO Send to Vendor
                → operator = "="
                → value    = Completed
                → click Add
  3. Copy the generated code out of the Inspector.
  4. Press  ▶ Resume  (or just close the browser) when done.

  Nothing is printed and nothing is written by this script.
════════════════════════════════════════════════════════════════
`);

    await page.pause();
  } finally {
    await conn.browser.close().catch(() => {});
  }
})();
