/**
 * Diagnostic: what does a machine actually get served at Odoo's DB selector?
 * Reproduces the exact step that fails in the batch (lib/odoo-nav.mjs:selectDatabase)
 * — same launch (headless Chrome channel) and same URL — but instead of clicking the
 * database link, it records what came back: HTTP status, final URL, page title,
 * whether the DB link is present, a screenshot, and the raw HTML.
 *
 * Answers one question: is the batch failing because the DB link is SLOW (real page,
 * bump the timeout) or ABSENT (a 403/block page — network wall, needs self-hosted runner)?
 *
 * The /web/database/selector page is PRE-LOGIN, so its HTML/screenshot carry no
 * credentials. Reads odooUrl from config.json (already materialized on the runner).
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const { odooUrl } = JSON.parse(readFileSync('config.json', 'utf8'));
const url = `${odooUrl}/web/database/selector`;
const outDir = 'capture';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newContext().then(c => c.newPage());
  // Capture the top-level HTTP status of the navigation itself.
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const status = resp ? resp.status() : 'no-response';

  // Give the page a moment to settle (mirror networkidle intent) but don't hang forever.
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const title = await page.title().catch(() => '(no title)');
  const finalUrl = page.url();
  const linkCount = await page.locator('a[href*="princ-smarterp-prod-base-"]').count().catch(() => -1);
  const html = await page.content();

  await page.screenshot({ path: `${outDir}/db-selector.png`, fullPage: true }).catch(() => {});
  writeFileSync(`${outDir}/db-selector.html`, html, 'utf8');
  writeFileSync(`${outDir}/verdict.txt`,
    [
      `httpStatus:   ${status}`,
      `finalUrl:     ${finalUrl}`,
      `pageTitle:    ${title}`,
      `dbLinkCount:  ${linkCount}   (0 = link ABSENT -> wall; >=1 = link present -> slowness)`,
      `htmlBytes:    ${html.length}`,
    ].join('\n') + '\n', 'utf8');

  // Print the verdict to the (masked) console too.
  console.log('=== CAPTURE VERDICT ===');
  console.log(readFileSync(`${outDir}/verdict.txt`, 'utf8'));
} finally {
  await browser.close().catch(() => {});
}
