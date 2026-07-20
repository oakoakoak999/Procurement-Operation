/**
 * Episode Index (Memory.md) — the compact "read first" timeline: ONE row per
 * batch run, appended in date order. Per-BU detail is NOT here (that lives in
 * the dated execution log); this table is the scannable rollup you skim before
 * pulling a daily file.
 *
 * Written automatically by run-batch.mjs alongside the execution log and the
 * leftover table, so all three of Memory.md's records stay current without a
 * hand edit. --test batches are logged too (Oak, 2026-07-16: every execution
 * logs), flagged in the Notable column so a rehearsal is easy to skim past.
 *
 * Columns (must match the existing header): Date | Run ID | Pipeline | Status |
 * Stats | Notable.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const MEMORY_FILE = 'agents/procurement-operator/memory/Memory.md';
const SECTION = '## Episode Index';

const pad = n => String(n).padStart(2, '0');

// Bangkok has no DST, so a fixed +07 offset is exact and dependency-free.
function bkkDate() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Insert one already-formatted row at the END of the Episode Index table (rows
// stay in ascending date order). Returns { file } or null if Memory.md / the
// section / its header can't be found (this writer never creates them).
function insertEpisodeRow(baseDir, row) {
  const file = join(baseDir, MEMORY_FILE);
  if (!existsSync(file)) return null;

  const lines = readFileSync(file, 'utf8').split('\n');
  const secIdx = lines.findIndex(l => l.trim() === SECTION);
  if (secIdx < 0) return null;
  const headerIdx = lines.findIndex((l, i) => i > secIdx && l.startsWith('| Date'));
  if (headerIdx < 0) return null;

  // Data rows are the contiguous run of '|'-rows after the separator.
  let endIdx = headerIdx + 2;
  while (endIdx < lines.length && lines[endIdx].startsWith('|')) endIdx++;

  const updated = [...lines.slice(0, endIdx), row, ...lines.slice(endIdx)];
  writeFileSync(file, updated.join('\n'));
  return { file };
}

const rollupStatus = results => {
  const failedN = results.filter(r => r.status === 'FAILED').length;
  return failedN === 0 ? 'SUCCESS' : failedN === results.length ? 'FAILED' : 'PARTIAL';
};

/**
 * Append one rollup row for a PR2PO batch to Memory.md's Episode Index.
 * `meta` = { batchId, profile, mode, generated }. `baseDir` is the repo root.
 */
export function appendEpisodeRow(results, meta, baseDir) {
  const passed   = results.reduce((n, r) => n + (r.appendedRows || 0), 0);
  const rejected = results.reduce((n, r) => n + (r.rejectedRows || 0), 0);
  const active   = results.filter(r => (r.appendedRows || 0) > 0 || (r.rejectedRows || 0) > 0).length;

  const stats = `${results.length} BU · ${active} active · ${passed} pass · ${rejected} reject · ${meta.generated || 0} PO`;
  const notable =
    meta.mode === 'test' ? '--test rehearsal (no PO)'
    : meta.mode === 'live' ? 'generate — real POs'
    : 'validate only';

  const row = `| ${bkkDate()} | ${meta.batchId} | PR2PO ${meta.profile} batch | ${rollupStatus(results)} | ${stats} | ${notable} |`;
  return insertEpisodeRow(baseDir, row);
}

/**
 * Append one rollup row for a PO-Daily batch to Memory.md's Episode Index.
 * `meta` = { batchId, date }. `results` are po-daily runStats objects
 * ({ status, printed, split, uploaded, skipped }). `baseDir` is the repo root.
 * PO-daily always takes real actions (print + Drive upload; upload de-dups) —
 * there is no rehearsal mode, so no --test flag to reflect here.
 */
export function appendPoDailyEpisodeRow(results, meta, baseDir) {
  const printed  = results.reduce((n, r) => n + (r.printed  || 0), 0);
  const uploaded = results.reduce((n, r) => n + (r.uploaded || 0), 0);
  const skipped  = results.reduce((n, r) => n + (r.skipped  || 0), 0);
  const active   = results.filter(r => (r.printed || 0) > 0).length;
  const noPO      = results.filter(r => r.status === 'WARN').length;
  const failedN   = results.filter(r => r.status === 'FAILED').length;

  const stats   = `${results.length} BU · ${active} with POs · ${printed} printed · ${uploaded} uploaded · ${skipped} dup-skip`;
  const notable = failedN > 0 ? `${failedN} BU failed` : noPO > 0 ? `${noPO} BU had no POs` : 'print + upload';

  const row = `| ${bkkDate()} | ${meta.batchId} | PO-Daily batch ${meta.date || ''} | ${rollupStatus(results)} | ${stats} | ${notable} |`;
  return insertEpisodeRow(baseDir, row);
}
