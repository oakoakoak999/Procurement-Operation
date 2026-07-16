/**
 * READ-ONLY probe for the Confirm-PO flow. Clicks nothing destructive: never
 * saves, never clicks Confirm/Apply, never edits a field. Opens one RFQ and
 * reports what the Expected Arrival field actually is, so odoo_po_confirm.mjs
 * can be written against facts instead of a codegen recording (which clicked
 * the calendar cell literally labelled "10" — a coincidence, not "+10 days").
 *
 * Usage: node tools/probe-po-confirm.mjs <BU_CODE> [--headless]
 * Example: node tools/probe-po-confirm.mjs PSUV
 */

import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { connectAndNavigate, selectDatabase, login, switchBU, navigateToRFQList } from '../lib/odoo-nav.mjs';
import { ODOO_URL, BU_ODOO_PREFIX } from '../lib/config.mjs';
import { loadEnv, log } from '../lib/util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '..', '.env'));

const USERNAME = process.env.ODOO_USERNAME;
const PASSWORD = process.env.ODOO_PASSWORD;
if (!USERNAME || !PASSWORD) throw new Error('ODOO_USERNAME / ODOO_PASSWORD not set in .env');

const BU       = process.argv[2];
const HEADLESS = process.argv.includes('--headless');
if (!BU) throw new Error('Usage: node tools/probe-po-confirm.mjs <BU_CODE> [--headless]');

const out = [];
const report = (k, v) => { out.push([k, v]); log(`  ${k}: ${v}`); };

// Each probe is isolated: one failure must not hide the findings that follow.
async function probe(name, fn) {
  try { return await fn(); }
  catch (e) { report(`${name} ERROR`, e.message.split('\n')[0]); return null; }
}

(async () => {
  const conn = await connectAndNavigate({ headless: HEADLESS });
  const { page } = conn;
  try {
    await selectDatabase(page, ODOO_URL);
    await login(page, { username: USERNAME, password: PASSWORD });
    const landedBU = await switchBU(page, BU, BU_ODOO_PREFIX);
    report('landedBU', landedBU ?? 'null (no switcher)');

    // ── Q3a: does a fresh session need an explicit "enter Purchase app" step? ──
    log('\n── Q3a: Purchase app entry');
    await probe('purchaseApp', async () => {
      const ordersVisible = await page.getByRole('button', { name: 'Orders' }).isVisible().catch(() => false);
      report('Orders button before entering app', ordersVisible ? 'VISIBLE (already in Purchase)' : 'ABSENT (entry step needed)');
      if (!ordersVisible) {
        await page.waitForSelector('.o_navbar_apps_menu button', { timeout: 30000 });
        await page.click('.o_navbar_apps_menu button');
        await page.waitForTimeout(1000);
        await page.click('a.o_app[href*="menu_id=340"]');
        await page.waitForTimeout(3000);
        report('entered Purchase app via menu_id=340', 'OK');
      }
    });

    await navigateToRFQList(page);
    report('RFQ list URL', page.url());

    // ── Q: is "RFQ >> None" applied by default, or must we apply it? ──
    log('\n── Q: default search facets');
    await probe('facets', async () => {
      const facets = await page.locator('.o_searchview_facet').allInnerTexts();
      report('facets present', facets.length ? facets.map(f => f.replace(/\s+/g, ' ').trim()).join(' | ') : '(none)');
    });

    // ── Q: can we read Reference + Buyer + Source Document per row? ──
    log('\n── Q: row columns (Buyer = the profile discriminator)');
    await probe('rows', async () => {
      const rows = page.locator('tr.o_data_row');
      const n = await rows.count();
      report('row count', n);
      for (let i = 0; i < n; i++) {
        const cell = async (f) => (await rows.nth(i).locator(`td[name="${f}"]`).innerText().catch(() => '?')).trim();
        report(`row ${i}`, `ref=${await cell('name')} | buyer=${await cell('buyer_id')} | origin=${await cell('origin')} | deadline=${await cell('date_order')} | state=${await cell('state')}`);
      }
    });

    // ── Q1/Q2: what IS the Expected Arrival field? ──
    log('\n── Q1/Q2: Expected Arrival field (format + type)');
    // Must open a record still in RFQ state: Odoo renders a confirmed/cancelled
    // record's fields as readonly divs, so an input[] probe finds nothing and
    // Confirm is absent. Pick the first row whose state cell reads exactly RFQ.
    await probe('openPO', async () => {
      const rows = page.locator('tr.o_data_row');
      const n = await rows.count();
      let target = -1;
      for (let i = 0; i < n; i++) {
        const st = (await rows.nth(i).locator('td[name="state"]').innerText().catch(() => '')).trim();
        if (st === 'RFQ') { target = i; break; }
      }
      if (target < 0) { report('RFQ-state row', 'NONE — every row is confirmed/cancelled'); return; }

      // Dump every named cell of the chosen row: reveals the real field name of
      // the "Order Deadline" column instead of guessing date_order.
      const cells = await rows.nth(target).evaluate(tr =>
        Array.from(tr.querySelectorAll('td[name]')).map(td => `${td.getAttribute('name')}=${td.innerText.trim().slice(0, 28)}`)
      );
      report('chosen RFQ row index', target);
      report('ALL named cells on that row', cells.join(' | '));

      await rows.nth(target).locator('td[name="name"]').click();
      await page.waitForTimeout(2500);
      report('opened PO, URL', page.url());
    });

    // Dump every date-ish field on the form with its tag — an input means
    // editable, a div means readonly. This is what tells us how to set it.
    await probe('formDateFields', async () => {
      const fields = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[name]'))
          .filter(el => /date|arrival|deadline|planned/i.test(el.getAttribute('name') || ''))
          .map(el => {
            const inp = el.tagName === 'INPUT' ? el : el.querySelector('input');
            return `${el.getAttribute('name')} <${el.tagName}${inp ? '/INPUT' : ''}> = ${JSON.stringify((inp ? inp.value : el.textContent.trim()).slice(0, 30))}`;
          })
          .slice(0, 15)
      );
      for (const f of fields) report('date field', f);
    });

    await probe('dateField', async () => {
      // date_planned is purchase.order's Expected Arrival in stock Odoo — verify.
      const byName = page.locator('input[name="date_planned"]');
      const found  = await byName.count() > 0;
      report('input[name="date_planned"] found', found);

      const el = found ? byName.first() : page.getByRole('textbox', { name: /Expected Arrival/i }).first();
      if (!found) report('fallback locator used', 'getByRole(textbox, /Expected Arrival/i)');

      const info = await el.evaluate((n) => ({
        tag: n.tagName, type: n.type, name: n.name,
        value: n.value, placeholder: n.placeholder,
        parentField: n.closest('[name]')?.getAttribute('name') || null,
        widget: n.closest('.o_field_widget')?.className || null,
      }));
      report('RAW VALUE (this reveals the format)', JSON.stringify(info.value));
      report('tag/type/name', `${info.tag} / ${info.type} / ${info.name}`);
      report('placeholder', JSON.stringify(info.placeholder));
      report('parent field name', info.parentField);
      report('widget class', info.widget);
      report('date vs datetime', /\d{1,2}:\d{2}/.test(info.value) ? 'DATETIME (has time component)' : 'DATE only');
    });

    // ── Order Deadline (date_order) = the chosen anchor. Same read as the
    // arrival field: we need its raw value and whether it carries a time.
    log('\n── ANCHOR: Order Deadline (date_order)');
    await probe('deadlineField', async () => {
      const el = page.locator('input[name="date_order"]').first();
      if (await el.count() === 0) { report('input[name="date_order"]', 'NOT FOUND on form'); return; }
      const info = await el.evaluate(n => ({ value: n.value, type: n.type }));
      report('deadline RAW VALUE', JSON.stringify(info.value));
      report('deadline date vs datetime', /\d{1,2}:\d{2}/.test(info.value) ? 'DATETIME' : 'DATE only');
    });

    // ── Does a "budget date" field exist at all? Nothing in the repo mentions
    // one, and it is not a list column — find out where it lives (if anywhere).
    log('\n── Budget date hunt (is it on the PO?)');
    await probe('budgetHunt', async () => {
      const hits = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[name], label')) {
          const nm  = el.getAttribute?.('name') || '';
          const txt = (el.textContent || '').trim();
          if (/budget/i.test(nm) || (/budget/i.test(txt) && txt.length < 40)) {
            out.push(`${el.tagName}[name=${nm || '-'}] "${txt.slice(0, 40)}"`);
          }
        }
        return out.slice(0, 10);
      });
      report('budget-ish fields on PO form', hits.length ? hits.join(' ; ') : 'NONE FOUND on this form');
    });

    // ── Q: Odoo's own locale format, straight from the session ──
    await probe('sessionFormat', async () => {
      const fmt = await page.evaluate(() => {
        const s = window.odoo?.session_info || window.odoo?.__session_info__;
        return s ? { lang: s.user_context?.lang, tz: s.user_context?.tz } : null;
      });
      report('session lang/tz', fmt ? JSON.stringify(fmt) : 'not exposed on window');
    });

    // ── Q4: does Confirm exist here, and does it warn? (NOT clicked) ──
    log('\n── Q4: Confirm button (not clicked)');
    await probe('confirmBtn', async () => {
      const btn = page.getByRole('button', { name: 'Confirm', exact: true }).first();
      report('Confirm button count', await page.getByRole('button', { name: 'Confirm', exact: true }).count());
      report('Confirm visible', await btn.isVisible().catch(() => false));
      report('Confirm enabled', await btn.isEnabled().catch(() => false));
    });

    // ── Q3b: how do we get back to the list for the next PO? ──
    log('\n── Q3b: breadcrumb back to list');
    await probe('breadcrumb', async () => {
      const crumbs = await page.locator('.o_breadcrumb, .breadcrumb').first().allInnerTexts().catch(() => []);
      report('breadcrumb text', crumbs.join(' ').replace(/\s+/g, ' ').trim() || '(none)');
      report('back locator candidate', await page.locator('.breadcrumb-item a, .o_back_button').count() > 0 ? '.breadcrumb-item a / .o_back_button present' : 'NOT FOUND');
    });

    log('\n════ PROBE SUMMARY ════');
    for (const [k, v] of out) log(`${k.padEnd(42)} ${v}`);
    log('\nNothing was saved, applied, or confirmed.');
    if (!HEADLESS) { log('Browser stays open 20s for a look...'); await page.waitForTimeout(20000); }
  } finally {
    await conn.browser.close().catch(() => {});
  }
})();
