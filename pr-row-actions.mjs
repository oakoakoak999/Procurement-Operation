/**
 * Shared Odoo PR row-selection and Actions-menu execution logic.
 * Used by odoo_pr_action.mjs (human-reviewed leftover approve/reject) and
 * odoo_pr_to_po.mjs (--generate: auto-approve PRs that pass validation).
 * Kept in one place so there is exactly one copy of the code that clicks an
 * irreversible Odoo action (Generate to PO has no confirm dialog) — a second,
 * drifted copy is how one file gets a fix and the other doesn't.
 */

export const ACTION_MENU_ITEM = {
  approve: 'Generate to PO',
  reject:  'Cancel PR',
};

// This list is per PR-LINE, not per-PR — a PR with multiple order lines shows
// one row per line, all sharing the same PR number. Validates every PR number
// resolves to at least one line row BEFORE checking any of them — a batch run
// either fully qualifies or aborts with nothing checked, never a partial check.
export async function selectPRRows(page, prNumbers, buyerLabel, log = () => {}) {
  const matched = [];
  for (const prNumber of prNumbers) {
    log(`Finding line row(s) for PR ${prNumber}...`);
    // Match on a cell whose text is EXACTLY the PR number — substring hasText
    // would also catch prefix collisions (PR00123 inside PR001234) or the
    // number appearing in another column, and check the wrong PR's rows.
    const rows = page.locator('tr.o_data_row').filter({
      has: page.getByRole('cell', { name: prNumber, exact: true }),
    });
    const count = await rows.count();
    if (count === 0) throw new Error(`PR "${prNumber}" not found in ${buyerLabel} group — already processed, or wrong BU/profile? (nothing checked yet)`);

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

// Unchecks the header "select all" checkbox if a prior step (e.g. XLSX export,
// which selects all visible rows) left it checked. Without this, selecting
// specific PR rows on top of an already-checked header would act on every
// visible row, not just the intended subset.
export async function resetSelection(page) {
  const headerCheckbox = page.locator('thead .o_list_record_selector input[type="checkbox"]');
  if (await headerCheckbox.count() > 0 && await headerCheckbox.isChecked()) {
    await headerCheckbox.uncheck();
    await page.waitForTimeout(300);
  }
}

// Cancel PR triggers a native browser confirm() dialog (unlike Generate to PO,
// which has none). Playwright auto-dismisses unhandled dialogs, which would
// silently no-op the cancellation — must explicitly accept it to take effect.
export async function executeOdooAction(page, action, { testMode = false, log = () => {} } = {}) {
  const menuItemName = ACTION_MENU_ITEM[action];
  if (!menuItemName) throw new Error(`Unknown action "${action}". Valid: approve | reject`);

  log('Opening Actions menu...');
  await page.click('.o_cp_action_menus button');
  await page.waitForTimeout(500);

  const item = page.locator('.o_cp_action_menus .dropdown-item').filter({ hasText: menuItemName });
  if (await item.count() === 0) throw new Error(`Menu item "${menuItemName}" not found in Actions dropdown`);

  if (testMode) {
    log(`[--test] Would click "${menuItemName}" now — skipping (no real Odoo action taken)`);
    await page.keyboard.press('Escape');
    return false;
  }

  if (action === 'reject') {
    page.once('dialog', dialog => {
      log(`Confirming dialog: "${dialog.message()}"`);
      dialog.accept().catch(() => {});
    });
  }

  log(`Clicking "${menuItemName}" — THIS IS FINAL${action === 'approve' ? ', no confirmation dialog in Odoo' : ''}...`);
  await item.first().click();
  await page.waitForTimeout(2000);
  log(`"${menuItemName}" executed`);
  return true;
}
