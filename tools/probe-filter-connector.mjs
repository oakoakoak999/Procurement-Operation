#!/usr/bin/env node
/**
 * probe-filter-connector.mjs — READ-ONLY.
 *
 * The two-condition filter needs the domain editor's any/all connector set
 * explicitly. Codegen recorded it as a button named "any" followed by a
 * menuitem named "any", which is ambiguous: either the dialog already defaults
 * to "any" and the click was a no-op, or it is a dropdown that must be opened.
 * Getting it wrong turns OR into AND silently and the run prints nothing —
 * so the control is inspected here rather than guessed at.
 *
 * Opens Add Custom Filter, adds a second rule, and dumps every candidate
 * control. Cancels the dialog; nothing is applied, printed or written.
 *
 * Usage: node tools/probe-filter-connector.mjs [BU] [--headless]
 */

import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { connectAndNavigate, selectDatabase, login, switchBU } from '../lib/odoo-nav.mjs';
import { ODOO_URL, BU_ODOO_PREFIX } from '../lib/config.mjs';
import { loadEnv, log } from '../lib/util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '..', '.env'));

const HEADLESS = process.argv.includes('--headless');
const BU = process.argv.find(a => !a.startsWith('--') && /^[A-Z]{2,6}$/.test(a)) || 'PSV';

const report = (k, v) => console.log(`\n### ${k}\n${v}`);

(async () => {
  const conn = await connectAndNavigate({ headless: HEADLESS });
  const { page } = conn;
  try {
    await selectDatabase(page, ODOO_URL);
    await login(page, { username: process.env.ODOO_USERNAME, password: process.env.ODOO_PASSWORD });
    const landed = await switchBU(page, BU, BU_ODOO_PREFIX);
    log(`BU: ${landed}`);

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

    await page.click('.o_searchview_dropdown_toggler');
    await page.waitForTimeout(600);
    await page.getByRole('menuitem', { name: 'Add Custom Filter' }).click();

    const dlg = page.locator('.modal').last();
    await dlg.locator('.o_model_field_selector').first().waitFor({ timeout: 15000 });

    report('ONE RULE — dialog text', (await dlg.innerText()).replace(/\n{2,}/g, '\n').trim());

    // Add the second rule: the connector control only becomes meaningful here.
    const newRule = dlg.getByRole('button', { name: 'New Rule', exact: true });
    report('New Rule button present', String(await newRule.count()));
    await newRule.click();
    await page.waitForTimeout(900);

    report('TWO RULES — dialog text', (await dlg.innerText()).replace(/\n{2,}/g, '\n').trim());

    report('all buttons in dialog', JSON.stringify(
      (await dlg.getByRole('button').allInnerTexts()).map(s => s.trim()), null, 1));

    report('all selects + options', JSON.stringify(await dlg.locator('select').evaluateAll(
      els => els.map((el, i) => ({
        i, value: el.value, cls: el.className,
        options: [...el.options].map(o => ({ v: o.value, t: o.text.trim() })),
      }))), null, 1));

    // The connector may be a dropdown rather than a select — capture the
    // markup around whichever element carries the any/all wording.
    report('connector candidates (html)', JSON.stringify(await dlg.locator(
      '.o_domain_selector, .o_domain_selector_row, .dropdown-toggle, [class*=connector], [class*=domain]'
    ).evaluateAll(els => els.slice(0, 12).map(el => ({
      tag: el.tagName, cls: el.className, text: (el.innerText || '').trim().slice(0, 120),
    }))), null, 1));

    const anyBtn = dlg.getByRole('button', { name: 'any', exact: true });
    const allBtn = dlg.getByRole('button', { name: 'all', exact: true });
    report('button named "any" / "all" counts', `any=${await anyBtn.count()}  all=${await allBtn.count()}`);

    if (await anyBtn.count()) {
      await anyBtn.first().click();
      await page.waitForTimeout(600);
      report('after clicking "any" — visible menuitems', JSON.stringify(
        (await page.getByRole('menuitem').allInnerTexts()).map(s => s.trim()), null, 1));
      await page.keyboard.press('Escape');
    } else if (await allBtn.count()) {
      await allBtn.first().click();
      await page.waitForTimeout(600);
      report('after clicking "all" — visible menuitems', JSON.stringify(
        (await page.getByRole('menuitem').allInnerTexts()).map(s => s.trim()), null, 1));
      await page.keyboard.press('Escape');
    }

    // Field list for the second condition's field, to confirm its exact label.
    report('note', 'Dialog will be cancelled — nothing applied.');
    await page.keyboard.press('Escape');
  } finally {
    await conn.browser?.close?.();
    await conn.close?.();
  }
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
