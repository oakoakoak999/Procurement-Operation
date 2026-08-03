#!/usr/bin/env node
/**
 * backfill-queue.mjs — run backfill-po-daily.mjs across every BU, one after another.
 *
 * backfill-po-daily.mjs handles one BU over a date range. This walks the BU list
 * and invokes it once per BU, so a whole-estate backfill is a single command that
 * survives being interrupted.
 *
 * Resumability is inherited rather than reimplemented: each BU keeps its own
 * runs/backfill-<BU>-<from>-<to>.json, so re-running this skips completed dates
 * within a partially-done BU, not just completed BUs. Killing it mid-BU costs at
 * most the dates currently in flight.
 *
 * BUs run STRICTLY ONE AT A TIME. Each BU already runs its own date lanes
 * internally (--max-parallel), and those lanes are the parallelism budget;
 * overlapping BUs on top would multiply Odoo sessions and Drive requests without
 * adding throughput, because the two share one browser stack and one Drive quota.
 * Tune --max-parallel, not this.
 *
 * Usage:
 *   node tools/backfill-queue.mjs --from 2026-01-01 --to 2026-06-30
 *                                 [--headless] [--clean] [--max-parallel 2]
 *                                 [--bus PSV,PPNP] [--skip PSV] [--dry-run]
 *                                 [--env=prod]
 *
 *   --bus    only these BUs, in this order. Default: all configured BUs.
 *   --skip   exclude these BUs (e.g. one already backfilled).
 *
 * State: runs/backfill-queue-<from>-<to>.json — per-BU outcome and timing.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { BU_ODOO_PREFIX, ODOO_ENV } from '../lib/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const has = f => process.argv.includes(f);

const FROM     = arg('--from');
const TO       = arg('--to');
const HEADLESS = has('--headless');
const CLEAN    = has('--clean');
const DRY      = has('--dry-run');
const LANES    = arg('--max-parallel', '2');

if (!FROM || !TO) {
  console.error('usage: node tools/backfill-queue.mjs --from 2026-01-01 --to 2026-06-30 [--headless] [--clean] [--max-parallel 2] [--bus A,B] [--skip C]');
  process.exit(2);
}

const split = s => (s ? s.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) : []);

// The BU list comes from lib/config.mjs, never from a literal here. That module
// is where blocked BUs are stripped, so taking the list from it means a BU
// blocked by policy can never be enumerated by this queue.
const ALL     = Object.keys(BU_ODOO_PREFIX);
const only    = split(arg('--bus'));
const skipped = new Set(split(arg('--skip')));

const unknown = only.filter(b => !ALL.includes(b));
if (unknown.length) throw new Error(`unknown or blocked BU(s): ${unknown.join(', ')}`);

const BUS = (only.length ? only : ALL).filter(b => !skipped.has(b));
if (!BUS.length) throw new Error('no BUs left to run after --bus/--skip');

// Suffixed by environment for the same reason as the per-BU state file: a prod
// pass and a UAT pass over one range are different jobs. UAT keeps the bare name.
const TAG   = ODOO_ENV === 'uat' ? '' : `-${ODOO_ENV}`;
const STATE = join(ROOT, 'runs', `backfill-queue-${FROM}-${TO}${TAG}.json`);

if (DRY) {
  console.log(`${BUS.length} BU(s): ${BUS.join(' ')}`);
  console.log(`range: ${FROM} → ${TO} | env: ${ODOO_ENV} | lanes: ${LANES} | headless: ${HEADLESS} | clean: ${CLEAN}`);
  process.exit(0);
}

mkdirSync(join(ROOT, 'runs'), { recursive: true });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { from: FROM, to: TO, bus: {} };
const save  = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

// Child stdio is inherited, not captured. Each BU's per-date detail already goes
// to runs/backfill-<BU>-<from>-<to>/<date>.log; buffering it here as well would
// only duplicate it and hide progress on a job measured in hours.
function runBu(bu) {
  return new Promise(resolve => {
    const args = [
      join('tools', 'backfill-po-daily.mjs'),
      '--bu', bu, '--from', FROM, '--to', TO,
      '--max-parallel', String(LANES),
      ...(HEADLESS ? ['--headless'] : []),
      ...(CLEAN ? ['--clean'] : []),
    ];
    // ODOO_ENV rather than a --env pass-through flag: the child cannot see this
    // process's argv, so without this a prod queue would run every BU on UAT.
    spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ODOO_ENV } })
      .on('close', code => resolve(code));
  });
}

// Read the per-BU state file the child wrote, so the queue summary reports real
// date counts instead of just an exit code.
function buTally(bu) {
  const f = join(ROOT, 'runs', `backfill-${bu}-${FROM}-${TO}${TAG}.json`);
  if (!existsSync(f)) return null;
  try {
    const dates = Object.values(JSON.parse(readFileSync(f, 'utf8')).dates || {});
    const sum = k => dates.reduce((a, v) => a + (v[k] || 0), 0);
    return {
      dates: dates.length,
      uploaded: sum('uploaded'),
      replaced: sum('replaced'),
      skipped: sum('skipped'),
      failed: dates.filter(v => v.status === 'FAILED').length,
    };
  } catch { return null; }
}

(async () => {
  const started = Date.now();
  console.log(`[QUEUE] ${BUS.length} BU(s) | ${FROM} → ${TO} | env=${ODOO_ENV} | ${LANES} date-lane(s) each`);
  console.log(`[QUEUE] order: ${BUS.join(' ')}`);
  console.log(`[QUEUE] state: ${STATE}\n`);

  let n = 0;
  for (const bu of BUS) {
    n++;
    const t0 = Date.now();
    console.log(`\n${'='.repeat(70)}\n[QUEUE] (${n}/${BUS.length}) ${bu} starting\n${'='.repeat(70)}`);

    const code  = await runBu(bu);
    const mins  = (Date.now() - t0) / 60000;
    const tally = buTally(bu);

    // A non-zero exit means some dates failed, NOT that the BU was skipped —
    // backfill-po-daily.mjs exits 1 when it finishes with failed dates. The
    // queue deliberately continues: one BU's bad dates should not strand the
    // other sixteen, and a re-run retries exactly those dates.
    state.bus[bu] = { exitCode: code, minutes: Number(mins.toFixed(1)), ...(tally || {}), at: new Date().toISOString() };
    save();

    console.log(`[QUEUE] (${n}/${BUS.length}) ${bu} done in ${mins.toFixed(0)}m — exit ${code}` +
      (tally ? ` | dates=${tally.dates} up=${tally.uploaded} repl=${tally.replaced} skip=${tally.skipped} failed=${tally.failed}` : ''));

    const elapsed = (Date.now() - started) / 60000;
    const eta = (elapsed / n) * (BUS.length - n);
    console.log(`[QUEUE] ${n}/${BUS.length} BUs done, ${elapsed.toFixed(0)}m elapsed, ~${(eta / 60).toFixed(1)}h remaining`);
  }

  const entries = Object.entries(state.bus);
  const bad = entries.filter(([, v]) => v.exitCode !== 0).map(([b]) => b);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`[QUEUE] complete in ${((Date.now() - started) / 3600000).toFixed(1)}h`);
  console.log(`  BUs: ${entries.length} | uploaded: ${entries.reduce((a, [, v]) => a + (v.uploaded || 0), 0)}`);
  if (bad.length) {
    console.log(`  BUs with failed dates: ${bad.join(', ')}`);
    console.log('  re-run the same command — only failed dates are retried.');
    process.exit(1);
  }
})();
