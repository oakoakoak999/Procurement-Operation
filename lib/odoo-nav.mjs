/**
 * Shared Odoo navigation steps: launch browser, select database, login,
 * switch BU, and navigate/prepare the Generate PR to PO list view.
 * Used by odoo_pr_to_po.mjs (export + validate + --generate) and
 * odoo_pr_action.mjs (human-reviewed leftover approve/reject) — one copy
 * instead of two drifting ones. Functions take page + config values as
 * parameters; nothing here reads script globals.
 */

import { chromium } from 'playwright';
import { log } from './util.mjs';

// ─── LAUNCH & CONNECT ─────────────────────────────────────────────────────────
export async function connectAndNavigate({ headless }) {
  log('Launching Chrome...');
  const browser = await chromium.launch({ headless, channel: 'chrome' });
  try {
    const context = await browser.newContext();
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
    return;
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
