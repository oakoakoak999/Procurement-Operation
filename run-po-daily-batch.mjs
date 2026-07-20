/**
 * Batch PO-Daily runner — runs po-daily-pipeline.mjs for every BU that has a
 * Drive order-folder configured (or a subset), a few at a time, and collects
 * each run's JSON result into one batch summary. The PO-Daily counterpart of
 * run-batch.mjs (which batches PR2PO); PO-daily is single-BU per invocation and
 * has no batch mode of its own, so this runner fans it out.
 *
 * Usage:
 *   node run-po-daily-batch.mjs [--date YYYY-MM-DD] [--headless]
 *                               [--skip-print] [--skip-split]
 *                               [--max-parallel=2] [--bu=PMDH,PPAT]
 *
 * --date/--headless/--skip-print/--skip-split are passed through to every run.
 * --date defaults to today (in the pipeline). Lane starts are staggered so
 * logins don't hit Odoo in the same instant.
 *
 * NO dry-run: PO-daily always takes real actions (print in Odoo, split PDFs,
 * upload to Drive). The upload de-dups against files already on Drive, so a
 * re-run skips existing names rather than duplicating — that is the safety net,
 * not a --test mode.
 *
 * Output: runs/<BATCH_ID>/ with one .log + .result.json per BU, plus
 * summary.json and summary.md. Exits 1 if any BU FAILED — WARN (no POs dated
 * that day) counts as OK.
 *
 * Ends with ONE memory-folder git sync (execution log + Episode Index row),
 * after every lane has exited — pipeline runs must never push concurrently
 * (see lib/memory-sync.mjs).
 */

import { spawn, spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { BU_ORDER_FOLDERS } from './lib/config.mjs';
import { makeRunId } from './lib/util.mjs';
import { syncMemoryFolder } from './lib/memory-sync.mjs';
import { appendPoDailyLog } from './lib/execution-log.mjs';
import { appendPoDailyEpisodeRow } from './lib/episode-index.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

// Pass-through boolean flags plus the --date VALUE pair (kept together so the
// child sees "--date 2026-07-20"). --max-parallel/--bu are batch-only, stripped.
const BOOL_FLAGS = ['--headless', '--skip-print', '--skip-split'].filter(f => process.argv.includes(f));
const _dateIdx   = process.argv.indexOf('--date');
const DATE_PAIR  = _dateIdx !== -1 ? ['--date', process.argv[_dateIdx + 1]] : [];
const PASS_ARGS  = [...BOOL_FLAGS, ...DATE_PAIR];

const MAX_PARALLEL = Number((process.argv.find(a => a.startsWith('--max-parallel=')) || '').split('=')[1]) || 2;
const BU_FILTER    = (process.argv.find(a => a.startsWith('--bu=')) || '').split('=')[1];
const BUS          = BU_FILTER ? BU_FILTER.split(',').map(s => s.trim()).filter(Boolean) : Object.keys(BU_ORDER_FOLDERS);
for (const bu of BUS) if (!BU_ORDER_FOLDERS[bu]) throw new Error(`BU "${bu}" has no Drive order folder in config. Valid: ${Object.keys(BU_ORDER_FOLDERS).join(', ')}`);

const STAGGER_MS = 3000;
const BATCH_ID   = makeRunId();
const RUN_DIR    = join(__dir, 'runs', BATCH_ID);
mkdirSync(RUN_DIR, { recursive: true });

function runBU(bu) {
  return new Promise(resolve => {
    const resultFile = join(RUN_DIR, `${bu}.result.json`);
    const logStream  = createWriteStream(join(RUN_DIR, `${bu}.log`));
    const child = spawn(process.execPath, ['po-daily-pipeline.mjs', '--bu', bu, ...PASS_ARGS], {
      cwd: __dir,
      env: { ...process.env, PODAILY_RESULT_FILE: resultFile },
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on('close', exitCode => {
      // The result file is the source of truth — its absence means the run died
      // before the pipeline's finally block (crash, OOM, kill).
      try {
        if (!existsSync(resultFile)) throw new Error(`no result file (exit code ${exitCode})`);
        resolve(JSON.parse(readFileSync(resultFile, 'utf8')));
      } catch (e) {
        resolve({ bu, status: 'FAILED', error: e.message });
      }
    });
  });
}

(async () => {
  // Pull the memory folder BEFORE the run so the end-of-run Episode Index /
  // execution-log append builds on the latest committed memory. Warn-never-fail
  // — a pull problem must not block the run; the end sync commits-then-pulls-then-pushes.
  const pull = spawnSync('git', ['pull', '--no-rebase', '--quiet'], { cwd: __dir, encoding: 'utf8' });
  console.log(pull.status === 0 ? '[BATCH] git pull ok' : `[BATCH] git pull skipped (continuing): ${(pull.stderr || '').trim() || 'non-zero exit'}`);

  console.log(`[BATCH] ${BATCH_ID} — PO-Daily | ${BUS.length} BU(s) | ${MAX_PARALLEL}-wide | args: ${PASS_ARGS.join(' ') || '(today, headed)'}`);
  const started = Date.now();

  const queue   = [...BUS];
  const results = [];
  async function lane() {
    while (queue.length) {
      const bu = queue.shift();
      console.log(`[BATCH] → ${bu} starting`);
      const r = await runBU(bu);
      console.log(`[BATCH] ← ${bu}: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
      results.push(r);
    }
  }
  const lanes = [];
  for (let i = 0; i < Math.min(MAX_PARALLEL, BUS.length); i++) {
    lanes.push(lane());
    if (queue.length) await new Promise(r => setTimeout(r, STAGGER_MS));
  }
  await Promise.all(lanes);

  // Preserve config BU order — lanes finish results out of order.
  results.sort((a, b) => BUS.indexOf(a.bu) - BUS.indexOf(b.bu));
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  const failed  = results.filter(r => r.status === 'FAILED');

  const summary = {
    batchId: BATCH_ID, pipeline: 'po-daily', args: PASS_ARGS,
    startedAt: new Date(started).toISOString(), minutes: Number(minutes),
    totals: {
      bus: results.length,
      failed: failed.length,
      noPO: results.filter(r => r.status === 'WARN').length,
      printed:  results.reduce((n, r) => n + (r.printed  || 0), 0),
      uploaded: results.reduce((n, r) => n + (r.uploaded || 0), 0),
      skipped:  results.reduce((n, r) => n + (r.skipped  || 0), 0),
    },
    results,
  };
  writeFileSync(join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  const mdRow = r => `| ${r.bu} | ${r.status} | ${r.printed ?? '-'} | ${r.split ?? '-'} | ${r.uploaded ?? '-'} | ${r.skipped ?? '-'} | ${r.error || ''} |`;
  const md = [
    `# Batch ${BATCH_ID} — PO-Daily (${PASS_ARGS.join(' ') || 'today, headed'})`,
    '',
    `${results.length} BU(s) in ${minutes} min — ${failed.length} failed, ${summary.totals.noPO} with no POs, ${summary.totals.printed} printed, ${summary.totals.uploaded} uploaded, ${summary.totals.skipped} dup-skipped`,
    '',
    '| BU | Status | Printed | Split | Uploaded | Skipped | Error |',
    '|---|---|---|---|---|---|---|',
    ...results.map(mdRow),
    '',
  ].join('\n');
  writeFileSync(join(RUN_DIR, 'summary.md'), md);
  console.log(`\n${md}`);
  console.log(`[BATCH] Written: ${join(RUN_DIR, 'summary.md')}`);

  // Every batch appends one per-BU block to the dated execution log and one
  // rollup row to Memory.md's Episode Index, then one sync pushes the whole
  // memory folder — after all pipeline processes have exited (Oak, 2026-07-16:
  // every execution logs). PO-daily has no leftover state (no PR rejections),
  // so there is no leftover-table upsert here.
  {
    const date = DATE_PAIR[1] || results.find(r => r.date)?.date || '';
    const logFile = appendPoDailyLog(results, __dir);
    console.log(`[BATCH] Execution log: ${logFile}`);
    const ep = appendPoDailyEpisodeRow(results, { batchId: BATCH_ID, date }, __dir);
    if (ep) console.log(`[BATCH] Episode Index: +1 row -> ${ep.file}`);
    syncMemoryFolder(`Batch ${BATCH_ID}: PO-Daily memory sync`);
  }

  if (failed.length > 0) process.exit(1);
})();
