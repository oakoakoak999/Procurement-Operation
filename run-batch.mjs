/**
 * Batch PR2PO runner — runs odoo_pr_to_po.mjs for every BU in config.json
 * (or a subset), a few at a time, and collects each run's JSON result into
 * one batch summary. This is the single entry point a cron job calls.
 *
 * Usage:
 *   node run-batch.mjs <profile> [--generate] [--test] [--headless]
 *                      [--max-parallel=4] [--bu=PMDH,PPAT]
 *
 * --generate/--test/--headless are passed through to every pipeline run.
 * Lane starts are staggered 3s so logins don't hit Odoo in the same instant.
 *
 * Output: runs/<BATCH_ID>/ with one .log + .result.json per BU, plus
 * summary.json and summary.md. Exits 1 if any BU FAILED — WARN (no pending
 * PRs, all duplicates) counts as OK.
 *
 * Ends with ONE memory-folder git sync — pipeline runs must never push
 * concurrently (see lib/memory-sync.mjs).
 */

import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { BU_ODOO_PREFIX } from './lib/config.mjs';
import { makeRunId } from './lib/util.mjs';
import { syncMemoryFolder } from './lib/memory-sync.mjs';
import { appendExecutionLog } from './lib/execution-log.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

const USAGE = 'Usage: node run-batch.mjs <profile> [--generate] [--test] [--headless] [--max-parallel=N] [--bu=CODE,CODE]';
const PROFILE = process.argv[2];
if (!PROFILE || PROFILE.startsWith('--')) throw new Error(USAGE);

const PASS_FLAGS   = ['--generate', '--test', '--headless'].filter(f => process.argv.includes(f));
const MAX_PARALLEL = Number((process.argv.find(a => a.startsWith('--max-parallel=')) || '').split('=')[1]) || 4;
const BU_FILTER    = (process.argv.find(a => a.startsWith('--bu=')) || '').split('=')[1];
const BUS          = BU_FILTER ? BU_FILTER.split(',').map(s => s.trim()).filter(Boolean) : Object.keys(BU_ODOO_PREFIX);
for (const bu of BUS) if (!BU_ODOO_PREFIX[bu]) throw new Error(`Unknown BU "${bu}". Valid: ${Object.keys(BU_ODOO_PREFIX).join(', ')}`);

const STAGGER_MS = 3000;
const BATCH_ID   = makeRunId();
const RUN_DIR    = join(__dir, 'runs', BATCH_ID);
mkdirSync(RUN_DIR, { recursive: true });

function runBU(bu) {
  return new Promise(resolve => {
    const resultFile = join(RUN_DIR, `${bu}.result.json`);
    const logStream  = createWriteStream(join(RUN_DIR, `${bu}.log`));
    const child = spawn(process.execPath, ['odoo_pr_to_po.mjs', PROFILE, bu, ...PASS_FLAGS], {
      cwd: __dir,
      env: { ...process.env, PR2PO_RESULT_FILE: resultFile },
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.on('close', exitCode => {
      // The result file is the source of truth — its absence means the run
      // died before the operator's finally block (crash, OOM, kill).
      try {
        if (!existsSync(resultFile)) throw new Error(`no result file (exit code ${exitCode})`);
        resolve(JSON.parse(readFileSync(resultFile, 'utf8')));
      } catch (e) {
        resolve({ bu, profile: PROFILE, status: 'FAILED', error: e.message });
      }
    });
  });
}

(async () => {
  console.log(`[BATCH] ${BATCH_ID} — profile: ${PROFILE} | ${BUS.length} BU(s) | ${MAX_PARALLEL}-wide | flags: ${PASS_FLAGS.join(' ') || '(none)'}`);
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
    batchId: BATCH_ID, profile: PROFILE, flags: PASS_FLAGS,
    startedAt: new Date(started).toISOString(), minutes: Number(minutes),
    totals: {
      bus: results.length,
      failed: failed.length,
      warn: results.filter(r => r.status === 'WARN').length,
      generated: results.reduce((n, r) => n + (r.generateExecuted ? (r.generateMatched?.length || 0) : 0), 0),
      leftovers: results.reduce((n, r) => n + (r.rejectedRows || 0), 0),
    },
    results,
  };
  writeFileSync(join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  const mdRow = r => {
    const gen = !PASS_FLAGS.includes('--generate') ? '-'
      : r.generateError ? 'FAILED'
      : !r.generateAttempted ? '-'
      : r.testMode ? `DRY-RUN (${(r.generateMatched || []).join(', ')})`
      : `EXECUTED (${(r.generateMatched || []).join(', ')})`;
    return `| ${r.bu} | ${r.status} | ${r.appendedRows ?? '-'} | ${r.rejectedRows ?? '-'} | ${gen} | ${r.error || ''} |`;
  };
  const md = [
    `# Batch ${BATCH_ID} — ${PROFILE} (${PASS_FLAGS.join(' ') || 'validate only'})`,
    '',
    `${results.length} BU(s) in ${minutes} min — ${failed.length} failed, ${summary.totals.warn} warn, ${summary.totals.generated} PO(s) generated, ${summary.totals.leftovers} leftover row(s) for review`,
    '',
    '| BU | Status | Passed rows | Rejected rows | Generate | Error |',
    '|---|---|---|---|---|---|',
    ...results.map(mdRow),
    '',
  ].join('\n');
  writeFileSync(join(RUN_DIR, 'summary.md'), md);
  console.log(`\n${md}`);
  console.log(`[BATCH] Written: ${join(RUN_DIR, 'summary.md')}`);

  // Real runs (not dry/rehearse) append a per-BU block to the dated execution
  // log, then one sync pushes the whole memory folder — after all pipeline
  // processes have exited. Dry/rehearse runs are throwaway: no log, no push.
  if (!PASS_FLAGS.includes('--test')) {
    const mode = PASS_FLAGS.includes('--generate') ? 'live' : 'validate';
    const logFile = appendExecutionLog(results, mode, __dir);
    console.log(`[BATCH] Execution log: ${logFile}`);
    syncMemoryFolder(`Batch ${BATCH_ID}: ${PROFILE} memory sync`);
  }

  if (failed.length > 0) process.exit(1);
})();
