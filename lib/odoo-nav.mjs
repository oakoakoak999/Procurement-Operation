/**
 * Shared Odoo navigation steps: launch browser, select database, login,
 * switch BU, and navigate/prepare the Generate PR to PO list view.
 * Used by odoo_pr_to_po.mjs (export + validate + --generate) and
 * odoo_pr_action.mjs (human-reviewed leftover approve/reject) — one copy
 * instead of two drifting ones. Functions take page + config values as
 * parameters; nothing here reads script globals.
 */

import { chromium } from 'playwright';
import { log, cfAccessHeaders } from './util.mjs';

// ─── LAUNCH & CONNECT ─────────────────────────────────────────────────────────
export async function connectAndNavigate({ headless }) {
  log('Launching Chrome...');
  const browser = await chromium.launch({ headless, channel: 'chrome' });
  try {
    // extraHTTPHeaders applies to every request this context makes (Odoo only).
    // Empty {} when no service token is set — no effect on inside-network runs.
    const context = await browser.newContext({ extraHTTPHeaders: cfAccessHeaders() });
    const page    = await context.newPage();
    return { browser, context, page };
  } catch (err) {
    await browser.close().catch(() => {}); // caller never gets the handle if this throws — close here or leak Chrome
    throw err;
  }
}

// ─── SELECT DATABASE ──────────────────────────────────────────────────────────
export async function selectDatabase(page, odooUrl) {
  log('Navigating to database selector...');
  await page.goto(`${odooUrl}/web/database/selector`);
  await page.waitForLoadState('networkidle');

  // Click the most recent princ-smarterp-prod-base-* database
  await page.click('a[href*="princ-smarterp-prod-base-"]');
  await page.waitForLoadState('load');
  log(`Database selected, URL: ${page.url()}`);
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
export async function login(page, { username, password }) {
  if (!page.url().includes('/login')) {
    log('Already logged in — skipping login');
    return;
  }
  log('Logging in...');
  await page.fill('input[name="login"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  log('Logged in');
}

// ─── SWITCH BU ────────────────────────────────────────────────────────────────
// Returns the company label actually clicked, or null when no switcher was found
// (single-company mode — the session stays in whatever BU it was already in).
// Callers record it: the run record otherwise only stores the BU that was
// requested, so a session left in the wrong BU is invisible after the fact.
export async function switchBU(page, buCode, buOdooPrefix) {
  log(`Switching BU to ${buCode}...`);

  // Wait for navbar to be ready
  await page.waitForSelector('.o_main_navbar', { timeout: 30000 });

  // Wait up to 5s for company switcher to attach — isVisible() is too strict and
  // returns false while the element is in DOM but not yet painted
  let switcherFound = false;
  try {
    await page.waitForSelector('.o_switch_company_menu', { timeout: 5000, state: 'attached' });
    switcherFound = true;
  } catch {}

  if (!switcherFound) {
    log('Company switcher not present — single-company mode, proceeding as-is');
    return null;
  }

  // Open company switcher
  await page.click('.o_switch_company_menu button');
  await page.waitForTimeout(1000);

  // Find company with matching code
  const companies = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.o_switch_company_menu [data-company-id]')).map(el => ({
      id: el.getAttribute('data-company-id'),
      label: el.querySelector('.company_label')?.textContent?.trim() || '',
    }))
  );

  const odooPrefix = buOdooPrefix[buCode];
  if (!odooPrefix) throw new Error(`Unknown BU "${buCode}". Valid: ${Object.keys(buOdooPrefix).join(', ')}`);
  const target = companies.find(c => c.label.startsWith(odooPrefix));
  if (!target) throw new Error(`BU "${buCode}" not found in company list`);

  log(`Found BU: ${target.label}`);
  await page.click(`[data-company-id="${target.id}"] .log_into`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  log(`Switched to ${buCode}`);
  return target.label;
}

// ─── NAVIGATE TO GENERATE PR TO PO ────────────────────────────────────────────
export async function navigateToPRtoPO(page) {
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

// ─── NAVIGATE TO REQUESTS FOR QUOTATION (post-generate PO lookup) ─────────────
// After "Generate to PO", the created PO shows in the RFQ list with the source
// PR in the "Source Document" (origin) column and the PO number in "Reference"
// (name). The generate click itself never returns the PO number — we come here
// to read it back. Path confirmed via codegen + a read-only DOM probe.
export async function navigateToRFQList(page) {
  log('Navigating to Requests for Quotation (PO lookup)...');
  // Post-generate the browser is STILL inside the Purchase app, so go straight to
  // Orders -> Requests for Quotation. Do NOT click Home Menu -> Purchase: the 9-dot
  // menu holds TWO "Purchase" menuitems (app tile + brand), so that click throws a
  // strict-mode ambiguity error (caught live 20260715-1020, first real generate).
  await page.getByRole('button', { name: 'Orders' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('menuitem', { name: 'Requests for Quotation' }).click();
  await page.waitForSelector('tr.o_data_row', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  log('On Requests for Quotation list');
}

// Reads the generated PO number for each PR from the RFQ list: matches the row
// whose Source Document (origin) cell equals the PR number and returns its
// Reference (name) cell = the PO number. Returns Map(prNumber -> poNumber|null).
// Non-fatal per PR — an unmatched PR maps to null and the caller falls back to a
// "generated" placeholder. If a persisted group-by filter is hiding rows, clears
// the search facets once (flattens the list) and retries the misses.
export async function scrapePONumbers(page, prNumbers, log = () => {}) {
  const result = new Map();
  let clearedFacets = false;

  for (const prNumber of prNumbers) {
    let po = await readPOForPR(page, prNumber);

    if (po === null && !clearedFacets) {
      clearedFacets = true;
      const removers = page.locator('.o_searchview .o_facet_remove');
      const n = await removers.count();
      for (let i = 0; i < n; i++) await removers.first().click().catch(() => {});
      if (n > 0) { await page.waitForTimeout(1500); po = await readPOForPR(page, prNumber); }
    }

    if (po) log(`PR ${prNumber} -> PO ${po}`);
    else    log(`PR ${prNumber} -> PO not found on RFQ list (logging as 'generated')`);
    result.set(prNumber, po);
  }
  return result;
}

// One PR's PO number, or null. Matches the row by an EXACT PR-number cell (same
// approach that resolved 1 row in the probe), then reads the Reference (name)
// cell and validates it against the PO format so a stray value can't leak in.
async function readPOForPR(page, prNumber) {
  const row = page.locator('tr.o_data_row').filter({
    has: page.getByRole('cell', { name: prNumber, exact: true }),
  }).first();
  if (await row.count() === 0) return null;
  const poCell = row.locator('td[name="name"]').first();
  if (await poCell.count() === 0) return null;
  const m = (await poCell.innerText()).trim().match(/\d{2}PO\d{8}/);
  return m ? m[0] : null;
}

// ─── REMOVE DEFAULT FILTER ────────────────────────────────────────────────────
export async function removeFilter(page) {
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

// ─── GROUP BY BUYER ───────────────────────────────────────────────────────────
export async function groupByBuyer(page) {
  log('Adding Group By: Buyer...');
  await page.click('.o_searchview_dropdown_toggler');
  await page.waitForTimeout(800);
  await page.selectOption('.o_add_custom_group_menu', 'buyer_id');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  log('Grouped by Buyer');
}

// ─── EXPAND BUYER GROUP ───────────────────────────────────────────────────────
// Returns false when the list is empty or the buyer group is absent — the
// caller decides whether that's an early exit (pr_to_po: nothing to process)
// or an error (pr_action: the requested PRs should exist).
export async function expandBuyerGroup(page, buyerLabel) {
  log(`Expanding ${buyerLabel} group...`);
  await page.waitForTimeout(1500);

  if (await page.locator('.o_group_header').count() === 0) {
    log('No PR groups found — list is empty');
    return false;
  }

  const target = page.locator('.o_group_header').filter({ hasText: buyerLabel });
  if (await target.count() === 0) {
    log(`${buyerLabel} group not found — no pending PRs`);
    return false;
  }

  await target.first().click();
  await page.waitForTimeout(2000);
  log(`${buyerLabel} expanded`);
  return true;
}
