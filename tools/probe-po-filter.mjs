/**
 * READ-ONLY probe for the "Add Custom Filter" dialog on the Purchase Orders
 * list. Opens the dialog and reports its real structure, then cancels.
 * NEVER clicks Add, never applies a filter, never prints a report.
 *
 * Exists because the codegen recording of this flow produced a positional
 * selector for the field chip:
 *     page.locator('div').filter({ hasText: /^Buyer$/ }).nth(3)
 * which depends on the rule row defaulting to a field labelled "Buyer" and on
 * that div being the 4th match in the document. This probe finds the semantic
 * handle to use instead — same reason probe-po-confirm.mjs exists.
 *
 * Usage: node tools/probe-po-filter.mjs [BU_CODE] [--headless]
 * Example: node tools/probe-po-filter.mjs PSNK
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

const BU       = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'PSNK';
const HEADLESS = process.argv.includes('--headless');

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

    // ── Q: what facets are present before we touch anything? ──
    log('\n── baseline facets');
    await probe('facets', async () => {
      const facets = await page.locator('.o_searchview_facet').allInnerTexts();
      report('facets before', facets.length ? facets.map(f => f.replace(/\s+/g, ' ').trim()).join(' | ') : '(none)');
    });

    // ── Open the dialog ──
    log('\n── opening Add Custom Filter');
    await probe('openDialog', async () => {
      await page.click('.o_searchview_dropdown_toggler');
      await page.waitForTimeout(600);
      const item = page.getByRole('menuitem', { name: 'Add Custom Filter' });
      report('menuitem "Add Custom Filter" count', await item.count());
      await item.click();
      await page.waitForTimeout(1200);
    });

    // ── Q: which container is the dialog? ──
    log('\n── dialog container');
    await probe('container', async () => {
      for (const sel of ['.modal', '.modal.show', '[role=dialog]', '.o_dialog']) {
        report(`count ${sel}`, await page.locator(sel).count());
      }
      const title = await page.locator('.modal-title, [role=dialog] h4').first().innerText().catch(() => '(none)');
      report('dialog title', title.trim());
    });

    const dlg = page.locator('.modal').last();

    // ── Q: what IS the field chip? (replaces the nth(3) div) ──
    log('\n── field selector control');
    await probe('fieldChip', async () => {
      for (const sel of ['.o_model_field_selector', '.o_field_selector', '.o_domain_leaf_field_selector']) {
        const n = await dlg.locator(sel).count();
        report(`count ${sel}`, n);
        if (n) {
          const txt = await dlg.locator(sel).first().innerText().catch(() => '');
          report(`text of ${sel}`, JSON.stringify(txt.replace(/\s+/g, ' ').trim().slice(0, 60)));
        }
      }
      // Fallback: dump the rule row's direct children so we can see the real shape.
      const shape = await dlg.evaluate(m => {
        const row = m.querySelector('.o_domain_node, .o_domain_leaf, .o_tree_editor_row, .o_tree_editor_condition');
        if (!row) return 'no known rule-row class matched';
        return `${row.className} >> ` + Array.from(row.children)
          .map(c => `<${c.tagName.toLowerCase()} class="${c.className}">`).join(' ');
      });
      report('rule row shape', shape);
    });

    // ── Q: the selects — which is operator, which is value, what options? ──
    log('\n── selects inside the dialog');
    await probe('selects', async () => {
      const info = await dlg.evaluate(m =>
        Array.from(m.querySelectorAll('select')).map((s, i) => ({
          i,
          cls: s.className,
          value: s.value,
          options: Array.from(s.options).slice(0, 12).map(o => `${JSON.stringify(o.value)}=${o.text.trim()}`),
        }))
      );
      report('select count', info.length);
      for (const s of info) {
        report(`select[${s.i}] class`, s.cls || '(none)');
        report(`select[${s.i}] current value`, JSON.stringify(s.value));
        report(`select[${s.i}] options`, s.options.join(' | ').slice(0, 400));
      }
    });

    // ── Q: buttons (confirm "Add" is stable, and find Cancel to exit) ──
    log('\n── dialog buttons');
    await probe('buttons', async () => {
      const btns = await dlg.locator('button').allInnerTexts();
      report('buttons', btns.map(b => b.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '));
    });

    // ── Exit without applying ──
    log('\n── cancelling (nothing applied)');
    await probe('cancel', async () => {
      const cancel = dlg.getByRole('button', { name: 'Cancel', exact: true });
      if (await cancel.count()) { await cancel.click(); report('closed via', 'Cancel'); }
      else { await page.keyboard.press('Escape'); report('closed via', 'Escape'); }
      await page.waitForTimeout(600);
      const facets = await page.locator('.o_searchview_facet').allInnerTexts();
      report('facets after', facets.length ? facets.map(f => f.replace(/\s+/g, ' ').trim()).join(' | ') : '(none)');
    });

    // ── PASS 2: what happens after the field is changed? ─────────────────────
    // The value control and the operator default are both derived from the
    // field's type, so pass 1 (field = Buyer, a many2one) says nothing about
    // the state we actually ship against. Reopen and switch the field.
    log('\n════ PASS 2: after switching the field ════');
    await probe('reopen', async () => {
      await page.click('.o_searchview_dropdown_toggler');
      await page.waitForTimeout(600);
      await page.getByRole('menuitem', { name: 'Add Custom Filter' }).click();
      await page.waitForTimeout(1200);
      report('reopened', await dlg.count() ? 'OK' : 'DIALOG NOT FOUND');
    });

    log('\n── field picker popover');
    await probe('popover', async () => {
      await dlg.locator('.o_model_field_selector').first().click();
      await page.waitForTimeout(800);
      const pop = page.locator('.o_model_field_selector_popover');
      report('popover count', await pop.count());
      report('popover has search input', await pop.locator('input').count());
      const btns = await pop.locator('button').allInnerTexts().catch(() => []);
      report('first popover buttons', btns.map(b => b.replace(/\s+/g, ' ').trim())
        .filter(Boolean).slice(0, 12).join(' | ').slice(0, 300));
    });

    log('\n── selecting "PO Send to Vendor" (field only — nothing applied)');
    await probe('pickField', async () => {
      const pop    = page.locator('.o_model_field_selector_popover');
      const search = pop.locator('input').first();
      if (await search.count()) {
        await search.fill('PO Send to Vendor');
        await page.waitForTimeout(800);
        report('typed into popover search', 'yes');
      }
      const btn = page.getByRole('button', { name: 'PO Send to Vendor' });
      report('button "PO Send to Vendor" count', await btn.count());
      await btn.first().click();
      await page.waitForTimeout(1200);
      report('field chip now reads',
        JSON.stringify((await dlg.locator('.o_model_field_selector').first().innerText()).replace(/\s+/g, ' ').trim()));
    });

    log('\n── selects AFTER the field change (the state we ship against)');
    await probe('selectsAfter', async () => {
      const info = await dlg.evaluate(m =>
        Array.from(m.querySelectorAll('select')).map((s, i) => ({
          i,
          cls: s.className,
          value: s.value,
          options: Array.from(s.options).slice(0, 14).map(o => `${JSON.stringify(o.value)}=${o.text.trim()}`),
        }))
      );
      report('select count AFTER', info.length);
      for (const s of info) {
        report(`AFTER select[${s.i}] current value`, JSON.stringify(s.value));
        report(`AFTER select[${s.i}] options`, s.options.join(' | ').slice(0, 400));
      }
    });

    log('\n── cancelling pass 2 (nothing applied)');
    await probe('cancel2', async () => {
      const cancel = dlg.getByRole('button', { name: 'Cancel', exact: true });
      if (await cancel.count()) await cancel.click();
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      const facets = await page.locator('.o_searchview_facet').allInnerTexts();
      report('facets after pass 2', facets.length ? facets.map(f => f.replace(/\s+/g, ' ').trim()).join(' | ') : '(none)');
    });

    // ── PASS 3: apply for real, read the facet label, then remove it ─────────
    // The production script guards against double-applying by looking for an
    // existing facet (same pattern as hasConfDate / hasProductBuyer), so it
    // needs the exact text the search bar shows. Applying a filter is a list
    // view query only — no record is changed and nothing is printed.
    log('\n════ PASS 3: apply → read facet → remove ════');
    // The pager saturates at "10000+", so it can't show whether the filter
    // excluded anything. Ticking the header checkbox makes Odoo reveal the
    // exact "Select all N" total for the current search — the same number the
    // pipeline logs. Selection is view state, not a write, so this stays
    // read-only; the checkbox is always cleared again afterwards.
    const exactCount = async () => {
      const cb = page.locator('thead .o_list_record_selector input[type="checkbox"]');
      if (await cb.evaluate(el => el.checked || el.indeterminate)) {
        await cb.click(); await page.waitForTimeout(400);
      }
      await cb.click();
      await page.waitForSelector('.o_list_selection_box', { timeout: 20000 });
      const txt = (await page.locator('.o_list_selection_box').textContent() ?? '')
        .replace(/\s+/g, ' ').trim();
      await cb.click(); await page.waitForTimeout(400);
      return txt;
    };

    await probe('applyForReal', async () => {
      // Record count BEFORE the filter — the only way to prove the filter
      // actually excludes rows rather than silently applying a no-op.
      report('total BEFORE filter', await exactCount());
      await page.click('.o_searchview_dropdown_toggler');
      await page.waitForTimeout(600);
      await page.getByRole('menuitem', { name: 'Add Custom Filter' }).click();
      await page.waitForTimeout(1200);

      await dlg.locator('.o_model_field_selector').first().click();
      await page.waitForTimeout(800);
      await page.locator('.o_model_field_selector_popover input').first().fill('PO Send to Vendor');
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'PO Send to Vendor' }).click();
      await page.waitForTimeout(1200);

      // Option values are JSON-encoded by the domain editor, hence the quotes.
      const selects = dlg.locator('select');
      await selects.nth(0).selectOption('"="');
      await page.waitForTimeout(400);
      await selects.nth(1).selectOption('"completed"');
      await page.waitForTimeout(400);
      report('operator set to', JSON.stringify(await selects.nth(0).inputValue()));
      report('value set to', JSON.stringify(await selects.nth(1).inputValue()));

      await dlg.getByRole('button', { name: 'Add', exact: true }).click();
      await page.waitForTimeout(2500);
    });

    log('\n── the facet (this is what the idempotency guard must match)');
    await probe('facetLabel', async () => {
      const facets = await page.locator('.o_searchview_facet').allInnerTexts();
      report('facet count', facets.length);
      facets.forEach((f, i) => report(`facet[${i}] TEXT`, JSON.stringify(f.replace(/\s+/g, ' ').trim())));
      const remove = await page.locator('.o_searchview_facet .o_facet_remove').count();
      report('.o_facet_remove present', remove);
      // Row count is capped by the page size, so it proves nothing on its own.
      // The pager total is the number that must move if the filter is real.
      report('row count after filter', await page.locator('tr.o_data_row').count());
      report('total AFTER filter', await exactCount());
    });

    log('\n── removing the filter (leave the view as we found it)');
    await probe('removeFacet', async () => {
      const rm = page.locator('.o_searchview_facet .o_facet_remove');
      const n  = await rm.count();
      for (let i = 0; i < n; i++) { await rm.first().click(); await page.waitForTimeout(700); }
      const facets = await page.locator('.o_searchview_facet').allInnerTexts();
      report('facets after removal', facets.length ? facets.join(' | ') : '(none) — view restored');
    });

    log('\n════ PROBE SUMMARY ════');
    for (const [k, v] of out) log(`${String(k).padEnd(34)} ${v}`);
    log('\nNothing was applied, filtered, or printed.');
    if (!HEADLESS) { log('Browser stays open 10s for a look...'); await page.waitForTimeout(10000); }
  } finally {
    await conn.browser.close().catch(() => {});
  }
})();
