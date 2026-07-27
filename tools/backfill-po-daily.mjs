#!/usr/bin/env node
/**
 * backfill-po-daily.mjs — run po-daily-pipeline.mjs across a date RANGE.
 *
 * The pipeline and run-po-daily-batch.mjs are both single-date; a historical
 * backfill is hundreds of dates and cannot be one long command. This walks the
 * range one date at a time and records the outcome of each, so the job is
 * **resumable**: re-running skips dates already marked done and picks up where
 * it stopped. Interrupting it (Ctrl-C, reboot, closing the laptop) is safe.
 *
 * Deliberately does NOT use run-po-daily-batch.mjs: that writes the agent
 * memory files and git-pushes once per invocation, which across ~180 dates
 * would mean ~180 commits of churn. One backfill state file is written instead,
 * and the memory record is a single manual entry at the end.
 *
 * Usage:
 *   node tools/backfill-po-daily.mjs --bu PSV --from 2026-01-01 --to 2026-06-30
 *                                    [--headless] [--clean] [--dry-run]
 *
 *   --clean    delete that date's printed page PDFs + split dir after a
 *              successful upload. Off by default — a 6-month PSV backfill is
 *              several GB in Downloads, so turn this on unless you want the
 *              local copies.
 *   --dry-run  print the date list and exit. Nothing is launched.
 *
 * State: runs/backfill-<BU>-<from>-<to>.json  (delete it to force a full redo)
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const has = f => process.argv.includes(f);

const BU       = arg('--bu');
const FROM     = arg('--from');
const TO       = arg('--to');
const HEADLESS = has('--headless');
const CLEAN    = has('--clean');
const DRY      = has('--dry-run');

if (!BU || !FROM || !TO) {
  console.error('usage: node tools/backfill-po-daily.mjs --bu PSV --from 2026-01-01 --to 2026-06-30 [--headless] [--clean] [--dry-run]');
  process.exit(2);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!ISO.test(FROM) || !ISO.test(TO)) throw new Error('--from/--to must be YYYY-MM-DD');

// Dates are built in UTC so a local DST shift can't skip or repeat a day.
function dateRange(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (end < d) throw new Error('--to is before --from');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const DATES     = dateRange(FROM, TO);
const RUN_DIR   = join(ROOT, 'runs', `backfill-${BU}-${FROM}-${TO}`);
const STATE     = join(ROOT, 'runs', `backfill-${BU}-${FROM}-${TO}.json`);
const DOWNLOADS = join(homedir(), 'Downloads');

if (DRY) {
  console.log(`${DATES.length} date(s): ${DATES[0]} … ${DATES[DATES.length - 1]}`);
  process.exit(0);
}

mkdirSync(RUN_DIR, { recursive: true });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { bu: BU, from: FROM, to: TO, dates: {} };
const save  = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

// A date is done if it succeeded or had no POs. FAILED dates are retried on the
// next pass — that is the point of keeping them in the state file rather than
// dropping them.
const isDone = d => ['SUCCESS', 'WARN'].includes(state.dates[d]?.status);

function runDate(date) {
  return new Promise(resolve => {
    const resultFile = join(RUN_DIR, `${date}.result.json`);
    const logStream  = createWriteStream(join(RUN_DIR, `${date}.log`));
    const args = ['po-daily-pipeline.mjs', '--bu', BU, '--date', date, ...(HEADLESS ? ['--headless'] : [])];
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, PODAILY_RESULT_FILE: resultFile },
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on('close', exitCode => {
      try {
        if (!existsSync(resultFile)) throw new Error(`no result file (exit code ${exitCode})`);
        resolve(JSON.parse(readFileSync(resultFile, 'utf8')));
      } catch (e) {
        resolve({ bu: BU, status: 'FAILED', error: e.message });
      }
    });
  });
}

// Only ever removes paths this pipeline itself created for this BU+date.
function cleanLocal(date) {
  const slug = date.replace(/-/g, '');
  const targets = [join(DOWNLOADS, `PO-${BU}-Split-${slug}`)];
  for (let p = 1; p <= 40; p++) targets.push(join(DOWNLOADS, `PO-${BU}-${slug}-p${p}.pdf`));
  for (const t of targets) if (existsSync(t)) rmSync(t, { recursive: true, force: true });
}

(async () => {
  const todo = DATES.filter(d => !isDone(d));
  console.log(`[BACKFILL] ${BU} | ${FROM} → ${TO} | ${DATES.length} date(s), ${todo.length} to run, ${DATES.length - todo.length} already done`);
  console.log(`[BACKFILL] state: ${STATE}`);
  if (!todo.length) { console.log('[BACKFILL] nothing to do'); return; }

  const started = Date.now();
  let n = 0;
  for (const date of todo) {
    n++;
    const t0 = Date.now();
    process.stdout.write(`[BACKFILL] (${n}/${todo.length}) ${date} … `);
    const r = await runDate(date);
    const mins = ((Date.now() - t0) / 60000).toFixed(1);

    state.dates[date] = {
      status: r.status,
      printed: r.printed ?? null,
      split: r.split ?? null,
      uploaded: r.uploaded ?? null,
      replaced: r.replaced ?? null,
      skipped: r.skipped ?? null,
      error: r.error ?? null,
      minutes: Number(mins),
      at: new Date().toISOString(),
    };
    save();

    console.log(`${r.status}${r.error ? ` — ${r.error}` : ''} | split=${r.split ?? '-'} up=${r.uploaded ?? '-'} repl=${r.replaced ?? '-'} skip=${r.skipped ?? '-'} (${mins}m)`);

    if (CLEAN && ['SUCCESS', 'WARN'].includes(r.status)) cleanLocal(date);

    // Running ETA — the only honest way to size a job whose per-date cost
    // varies by an order of magnitude between a weekend and a month-end.
    const elapsed = (Date.now() - started) / 60000;
    const eta = (elapsed / n) * (todo.length - n);
    if (n % 5 === 0 || n === todo.length)
      console.log(`[BACKFILL] ${n}/${todo.length} done, ${elapsed.toFixed(0)}m elapsed, ~${eta.toFixed(0)}m remaining`);
  }

  const all  = Object.entries(state.dates);
  const sum  = k => all.reduce((a, [, v]) => a + (v[k] || 0), 0);
  const fail = all.filter(([, v]) => v.status === 'FAILED').map(([d]) => d);

  console.log(`\n[BACKFILL] ${BU} ${FROM} → ${TO} complete in ${((Date.now() - started) / 60000).toFixed(0)}m`);
  console.log(`  dates: ${all.length} | uploaded: ${sum('uploaded')} | replaced: ${sum('replaced')} | unchanged: ${sum('skipped')}`);
  console.log(`  no POs (WARN): ${all.filter(([, v]) => v.status === 'WARN').length} | FAILED: ${fail.length}`);
  if (fail.length) {
    console.log(`  failed dates: ${fail.join(', ')}`);
    console.log('  re-run the same command to retry only those.');
    process.exit(1);
  }
})();
