/**
 * Expected Arrival date for a confirmed PO: today + N working days, where
 * working day = Mon-Fri. Thai public holidays are NOT excluded.
 *
 * Timezone matters here. GitHub Actions runners are UTC, so a run at 03:00
 * Bangkok is still "yesterday" by the runner's clock and every arrival date
 * would land a day early. We resolve today in Asia/Bangkok explicitly, then do
 * the arithmetic on a UTC-midnight anchor so it stays pure calendar maths.
 */

// Today in Asia/Bangkok, as a UTC-midnight Date (the anchor for arithmetic).
export function bangkokToday(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return new Date(`${ymd}T00:00:00Z`);
}

// Counts forward, skipping Sat/Sun. The start day is never counted, so a Friday
// + 1 is the following Monday.
export function addWorkingDays(from, days) {
  if (!Number.isInteger(days) || days < 0) throw new Error(`addWorkingDays: days must be a non-negative integer, got ${days}`);
  const d = new Date(from.getTime());
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

// dd/mm/yyyy — verified against Odoo's date_order / date_planned via
// tools/probe-po-confirm.mjs (real values read as "25/06/2026 07:00:00").
export function formatDDMMYYYY(d) {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

// Parses Odoo's displayed "dd/mm/yyyy hh:mm:ss" to a UTC-midnight anchor. The
// time is dropped on purpose: it is a display artefact of the Bangkok offset
// (Odoo stores midnight UTC and renders it as 07:00), and working-day counting
// is calendar arithmetic — a time component would only invite drift.
export function parseOdooDate(s) {
  const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) throw new Error(`Unparseable Odoo date: ${JSON.stringify(s)} (expected dd/mm/yyyy)`);
  const [, dd, mm, yyyy] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid Odoo date: ${JSON.stringify(s)}`);
  // Round-trip guard: catches 31/02/2026, which Date would silently roll over.
  if (formatDDMMYYYY(d) !== `${dd}/${mm}/${yyyy}`) throw new Error(`Nonexistent date: ${JSON.stringify(s)}`);
  return d;
}

// Writes back in the same shape Odoo displays. 07:00:00 is Bangkok's rendering
// of midnight UTC — matching it keeps the stored value on the day boundary,
// exactly like every existing record.
export function formatOdooDateTime(d) {
  return `${formatDDMMYYYY(d)} 07:00:00`;
}
