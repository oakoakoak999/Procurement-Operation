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
 * Run statuses: SUCCESS | LEFTOVER | NONE | ERROR. All times Asia/Bangkok (+07).
 * NONE = ran clean but nothing to do (no pending PRs / all duplicates) — NOT a failure.
 *
 * Written batch-level (run-batch.mjs), once, after every lane has exited — BUs
 * run in parallel, so per-BU appends to one daily file would race.
 *
 * Standing rule (Oak, 2026-07-16): EVERY execution is logged, rehearsals
 * included — a dry-run writes a block flagged as such rather than writing
 * nothing. A run that leaves no trace is indistinguishable from a run that never
 * happened. appendConfirmLog below follows this for both modes. NOTE: the older
 * PR2PO path (appendExecutionLog, called from odoo_pr_to_po.mjs / run-batch.mjs)
 * still skips --test runs — that predates the rule and is a known deviation.
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

  // Precedence: ERROR > LEFTOVER > NONE > SUCCESS. A benign early-exit (no pending
  // PRs / all duplicates) sets r.status='WARN' AND r.error, but that is NOT a failure
  // — only r.status==='FAILED' or a generateError is a real ERROR. The WARN case
  // falls through to NONE (ran clean, nothing to do). Do NOT gate ERROR on r.error:
  // it's set on both benign WARNs and real FAILEDs, and would mislabel every idle BU.
  const status =
    (r.status === 'FAILED' || r.generateError) ? 'ERROR'
    : idle.length > 0 ? 'LEFTOVER'
    : (passList.length === 0 && !(r.appendedRows > 0)) ? 'NONE'
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

// Appends text as a block to today's file, creating it on first write.
function appendBlocks(text, baseDir) {
  const file = join(baseDir, MEMORY_DIR, `${bkkDateNow()}.md`);
  if (!existsSync(file)) writeFileSync(file, FILE_HEADER);
  appendFileSync(file, text + '\n\n');
  return file;
}

/**
 * Append one block per BU result to
 * agents/procurement-operator/memory/<YYYY-MM-DD>.md (Asia/Bangkok date).
 * `mode` is 'live' (--generate) or 'validate' (no --generate).
 * `baseDir` is the repo root. Returns the file path written.
 */
export function appendExecutionLog(results, mode, baseDir) {
  return appendBlocks(results.map(r => blockFor(r, mode)).join('\n\n'), baseDir);
}

/**
 * Confirm-PO's own block grammar — a confirm run has no PRs, no exported rows
 * and no leftover state, so it can't honestly reuse blockFor's counts. Shares
 * the daily file so one day's procurement activity reads in one place.
 *
 *   - DONE <PO> <PR> deadline <dd/mm/yyyy> +Nwd -> <dd/mm/yyyy>   (written+confirmed)
 *   - PLAN <PO> <PR> ...                                          (dry-run; nothing written)
 *   - FAIL <PO> - <reason>
 *
 * `mode` is 'live' (--confirm) or 'dry-run'. Both are logged.
 */
export function appendConfirmLog(r, baseDir) {
  const status =
    r.error || r.failed.length ? 'ERROR'
    : r.targets === 0 ? 'NONE'
    : 'SUCCESS';

  const lines = [
    `## ${timeFromRunId(r.runId)} +07 - CONFIRM-PO ${r.profile} ${r.bu} - ${status}`,
    `- run_id: ${r.runId}`,
    `- mode: ${r.mode}`,
    `- counts: targets=${r.targets} confirmed=${r.done.length} planned=${r.planned.length} failed=${r.failed.length}`,
    ...r.done.map(x => `- DONE ${x}`),
    ...r.planned.map(x => `- PLAN ${x}`),
    ...r.failed.map(x => `- FAIL ${x}`),
  ];
  // Only meaningful after a live run: a dry-run confirms nothing, so every
  // target is trivially still RFQ and reporting it would read as a failure.
  if (r.stillRFQ !== null) {
    lines.push(`- still_rfq: ${r.stillRFQ.length ? r.stillRFQ.join(', ') : 'none - all confirmed'}`);
  }
  if (r.error) lines.push(`- error: ${r.error}`);
  return appendBlocks(lines.join('\n'), baseDir);
}
