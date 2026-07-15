/**
 * Execution log — appends one human- and grep-readable block per BU run to a
 * dated markdown file in the memory folder, so past PR2PO runs can be read
 * straight from git (no Google Sheets / MCP calls to reconstruct history).
 *
 * This file is an IMMUTABLE per-run EVENT record. The CURRENT leftover state
 * (which idle PRs still await accept/deny) lives in Memory.md's
 * "Pending Leftover PRs" table — NOT here. Do not compute "what is leftover
 * now" from this log: old blocks are never edited when a PR is later resolved.
 *
 * Line grammar (ASCII-only tokens so it survives PowerShell/git/grep):
 *   - PASS <PR> -> <PO>        (live run; -> generated if PO scrape missed)
 *   - PASS <PR> -> pass        (validate run, no PO fired)
 *   - IDLE <PR> - <reason>
 * Run statuses: SUCCESS | LEFTOVER | NOOP | ERROR. All times Asia/Bangkok (+07).
 *
 * Written batch-level (run-batch.mjs), once, after every lane has exited — BUs
 * run in parallel, so per-BU appends to one daily file would race.
 */
import { appendFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = 'agents/procurement-operator/memory';
const FILE_HEADER =
  '<!-- PR2PO execution log — one block per BU run, appended, immutable.\n' +
  '     Current leftover (accept/deny) state lives in Memory.md, not here. -->\n\n';

const pad = n => String(n).padStart(2, '0');

// Bangkok has no DST, so a fixed +07 offset is exact and dependency-free.
function bkkDateNow() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// runId is YYYYMMDD-HHMM, minted Asia/Bangkok (the workflow sets TZ; a local PC
// is already +07). Recover the heading time from it; fall back to now if a run
// died before minting one (synthesized FAILED result).
function timeFromRunId(runId) {
  const m = /^\d{4}\d{2}\d{2}-(\d{2})(\d{2})$/.exec(runId || '');
  if (m) return `${m[1]}:${m[2]}`;
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// The pipeline records idle PRs as one '; '-joined string of "PR: reason"
// (there is no structured per-PR array in the result). Split it back into
// one IDLE line per PR. The PR number is the text before the first ": ".
function idleLines(rejectionReasons) {
  return (rejectionReasons || '')
    .split('; ')
    .map(s => s.trim())
    .filter(Boolean)
    .map(seg => {
      const i = seg.indexOf(': ');
      const pr = i >= 0 ? seg.slice(0, i) : seg;
      const reason = i >= 0 ? seg.slice(i + 2) : '(no reason recorded)';
      return `- IDLE ${pr} - ${reason}`;
    });
}

function blockFor(r, mode) {
  const live = mode === 'live';
  // Live: the PRs that actually became POs, each { pr, po } (po null if the
  // post-generate scrape missed). Validate: the PRs that passed validation
  // (plain strings, no PO fired).
  const passList = live ? (r.generateMatched || []) : (r.passingPRNumbers || []);
  const idle = idleLines(r.rejectionReasons);

  // Precedence: ERROR > LEFTOVER > NOOP > SUCCESS.
  const status =
    (r.status === 'FAILED' || r.error || r.generateError) ? 'ERROR'
    : idle.length > 0 ? 'LEFTOVER'
    : (passList.length === 0 && !(r.appendedRows > 0)) ? 'NOOP'
    : 'SUCCESS';

  // Live: `- PASS <PR> -> <PO>` (falls back to `generated` when the PO number
  // wasn't scraped). Validate: `- PASS <PR> -> pass`.
  const passLines = live
    ? passList.map(x => `- PASS ${x.pr} -> ${x.po || 'generated'}`)
    : passList.map(pr => `- PASS ${pr} -> pass`);

  const lines = [
    `## ${timeFromRunId(r.runId)} +07 - PR2PO ${r.profile || '?'} ${r.bu || '?'} - ${status}`,
    `- run_id: ${r.runId || '(none - run died early)'}`,
    `- mode: ${mode}`,
    `- counts: exported=${r.exportedRows ?? 0} pass=${passList.length} idle=${idle.length} skipped_dup=${r.skippedRows ?? 0}`,
    ...passLines,
    ...idle,
  ];
  if (status === 'ERROR') {
    lines.push(`- error: ${r.error || r.generateError || r.stoppedAt || 'unknown failure'}`);
  }
  return lines.join('\n');
}

/**
 * Append one block per BU result to
 * agents/procurement-operator/memory/<YYYY-MM-DD>.md (Asia/Bangkok date).
 * `mode` is 'live' (--generate) or 'validate' (no --generate). Test/dry-run
 * batches must NOT call this — they are rehearsals and don't push either.
 * `baseDir` is the repo root. Returns the file path written.
 */
export function appendExecutionLog(results, mode, baseDir) {
  const file = join(baseDir, MEMORY_DIR, `${bkkDateNow()}.md`);
  if (!existsSync(file)) writeFileSync(file, FILE_HEADER);
  appendFileSync(file, results.map(r => blockFor(r, mode)).join('\n\n') + '\n\n');
  return file;
}
