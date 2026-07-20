/**
 * Pending Leftover PRs table (Memory.md) — the CURRENT set of PRs that PR2PO
 * rejected (vendor mismatch / min-order / etc.) and that still await a human
 * accept-or-deny. Unlike the execution log (an immutable per-run event record),
 * this table is state: one row per open PR, readable straight from git.
 *
 * This writer UPSERTS: for every rejection in a batch it adds a row keyed by PR
 * number, and never touches a PR already listed (earliest First Seen wins). It
 * NEVER removes rows — a PR leaves the table only when a human clears it (or a
 * real accept/deny action does). So a PR fixed upstream lingers until cleared;
 * that is deliberate (no auto-remove — a BU with an empty export that day looks
 * identical to "resolved", so silent deletion would be unsafe).
 *
 * Mode column (Oak, 2026-07-16 "every execution logs, rehearsals included"):
 *   test  — found by a --test dry-run; NO PO fired, NO real action taken
 *   live  — found by a real run (validate/generate)
 * A test row is a real leftover worth a human's eyes, just flagged as surfaced
 * by a rehearsal. parseRejections is shared with the execution log so both read
 * the pipeline's '; '-joined rejection string identically.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseRejections } from './execution-log.mjs';

const MEMORY_FILE = 'agents/procurement-operator/memory/Memory.md';
const SECTION = '## Pending Leftover PRs';

const pad = n => String(n).padStart(2, '0');

// Bangkok has no DST, so a fixed +07 offset is exact and dependency-free
// (same basis as execution-log's bkkDateNow — kept local to avoid coupling).
function bkkDate() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Upsert every rejected PR from `results` into Memory.md's leftover table.
 * `mode` is stored verbatim in the Mode column ('test' | 'live'). `baseDir` is
 * the repo root. Returns { file, added } or null if the table can't be found
 * (Memory.md missing / section absent — this writer never creates them).
 */
export function upsertLeftovers(results, mode, baseDir) {
  const file = join(baseDir, MEMORY_FILE);
  if (!existsSync(file)) return null;

  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // Locate the table: the "| PR Number" header row inside the section, then its
  // separator, then the contiguous run of '|'-rows that follow.
  const secIdx = lines.findIndex(l => l.trim() === SECTION);
  if (secIdx < 0) return null;
  const headerIdx = lines.findIndex((l, i) => i > secIdx && l.startsWith('| PR Number'));
  if (headerIdx < 0) return null;

  const sepIdx = headerIdx + 1;
  let endIdx = sepIdx + 1;
  while (endIdx < lines.length && lines[endIdx].startsWith('|')) endIdx++;

  // First cell of each data row is the PR number — the upsert key.
  const seen = new Set(
    lines.slice(sepIdx + 1, endIdx).map(r => r.split('|')[1].trim())
  );

  const today = bkkDate();
  const newRows = [];
  for (const r of results) {
    for (const { pr, reason } of parseRejections(r.rejectionReasons)) {
      if (!pr || seen.has(pr)) continue;
      seen.add(pr);
      // A '|' inside the reason would break the markdown row — neutralize it.
      const safeReason = reason.replace(/\|/g, '/').trim();
      newRows.push(
        `| ${pr} | ${r.profile || '?'} | ${r.bu || '?'} | ${safeReason} | ${today} | ${r.runId || '-'} | ${mode} |`
      );
    }
  }
  if (newRows.length === 0) return { file, added: 0 };

  const updated = [...lines.slice(0, endIdx), ...newRows, ...lines.slice(endIdx)];
  writeFileSync(file, updated.join('\n'));
  return { file, added: newRows.length };
}
