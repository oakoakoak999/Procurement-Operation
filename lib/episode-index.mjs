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

/**
 * Append one rollup row for a batch to Memory.md's Episode Index.
 * `meta` = { batchId, profile, mode, generated }. `baseDir` is the repo root.
 * Returns { file } or null if Memory.md / the section can't be found (this
 * writer never creates them).
 */
export function appendEpisodeRow(results, meta, baseDir) {
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

  const passed   = results.reduce((n, r) => n + (r.appendedRows || 0), 0);
  const rejected = results.reduce((n, r) => n + (r.rejectedRows || 0), 0);
  const active   = results.filter(r => (r.appendedRows || 0) > 0 || (r.rejectedRows || 0) > 0).length;
  const failedN  = results.filter(r => r.status === 'FAILED').length;
  const status   = failedN === 0 ? 'SUCCESS' : failedN === results.length ? 'FAILED' : 'PARTIAL';

  const stats = `${results.length} BU · ${active} active · ${passed} pass · ${rejected} reject · ${meta.generated || 0} PO`;
  const notable =
    meta.mode === 'test' ? '--test rehearsal (no PO)'
    : meta.mode === 'live' ? 'generate — real POs'
    : 'validate only';

  const row = `| ${bkkDate()} | ${meta.batchId} | PR2PO ${meta.profile} batch | ${status} | ${stats} | ${notable} |`;
  const updated = [...lines.slice(0, endIdx), row, ...lines.slice(endIdx)];
  writeFileSync(file, updated.join('\n'));
  return { file };
}
