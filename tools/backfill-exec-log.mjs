/**
 * READ-ONLY reconciliation report for the execution-log backfill (per the
 * 2026-07-15 home-PC reminder). Direct-run auto-logging only landed 2026-07-15,
 * so PR2PO runs done directly (not via run-batch) before then wrote a row to
 * each BU's GSheet "Execute Log" tab but NO block to the memory folder.
 *
 * This tool reads every BU's Execute Log tab and the memory folder, and prints
 * the runs present in a sheet but MISSING from the memory folder. It writes
 * nothing — the actual append is a separate, deliberate step once the list is
 * reviewed (an execution log is append-only and immutable; a wrong block can't
 * be cleanly removed later).
 *
 * Note: the Execute Log stores counts + idle/rejected PR reasons, but not the
 * passing PR numbers or PO numbers. So a live/SUCCESS run can only be fully
 * reconstructed with the Odoo RFQ list (Source Document = PR, Reference = PO);
 * this report flags what each missing run would need.
 *
 * Usage: node tools/backfill-exec-log.mjs [--before=YYYY-MM-DD]
 */

import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { getSheetClient } from '../lib/sheets-client.mjs';
import { BU_LOG_SHEETS } from '../lib/config.mjs';
import { loadEnv, log } from '../lib/util.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '..', '.env'));

const BEFORE = (process.argv.find(a => a.startsWith('--before=')) || '--before=2026-07-15').split('=')[1];
const MEM_DIR = join(__dir, '..', 'agents', 'procurement-operator', 'memory');
const TOKEN   = join(__dir, '..', '.gsheets-token.json');

// dd/mm/yyyy -> yyyy-mm-dd for comparison; returns '' if unparseable.
function toISO(ddmmyyyy) {
  const m = String(ddmmyyyy).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

// run_ids and coarse (date, buToken) keys already present in the memory folder.
function alreadyLogged() {
  const ids = new Set();
  const coarse = new Set(); // "YYYY-MM-DD|BU"
  for (const f of readdirSync(MEM_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))) {
    const date = f.replace('.md', '');
    const text = readFileSync(join(MEM_DIR, f), 'utf8');
    for (const m of text.matchAll(/run_id:\s*(\S+)/g)) ids.add(m[1]);
    for (const m of text.matchAll(/^##\s.*?(P[A-Z0-9]{2,5})\b/gm)) coarse.add(`${date}|${m[1]}`);
  }
  return { ids, coarse };
}

(async () => {
  const sheets = await getSheetClient({ tokenFile: TOKEN, interactive: false });
  const { ids, coarse } = alreadyLogged();
  log(`Memory folder already logs ${ids.size} run_id(s). Reporting Execute Log runs before ${BEFORE} that are missing.\n`);

  const missing = [];
  for (const [bu, sheetId] of Object.entries(BU_LOG_SHEETS)) {
    let rows;
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'Execute Log'!A:N` });
      rows = res.data.values || [];
    } catch (e) {
      log(`  ${bu}: could not read Execute Log (${e.message.split('\n')[0]})`);
      continue;
    }
    for (const r of rows.slice(1)) {
      const [runId, date, time, status] = r;
      if (!runId || !/^\d{8}-\d{4}$/.test(String(runId).trim())) continue; // skip header/junk rows
      const iso = toISO(date);
      if (iso && iso >= BEFORE) continue;              // only pre-cutover runs
      if (ids.has(String(runId).trim())) continue;     // already logged by run_id
      const dupCoarse = iso ? coarse.has(`${iso}|${bu}`) : false;
      missing.push({ bu, runId: String(runId).trim(), iso, time, status: String(status || '').trim(),
        appended: r[5], skipped: r[6], rejectionReasons: r[11], error: r[13], dupCoarse });
    }
  }

  missing.sort((a, b) => (a.iso + a.runId).localeCompare(b.iso + b.runId));
  if (missing.length === 0) { log('No missing runs — memory folder is complete for the window.'); return; }

  log(`${missing.length} missing run(s):\n`);
  for (const m of missing) {
    const live = /\(TEST\)/i.test(m.status) ? 'TEST' : (Number(m.appended) > 0 ? 'LIVE?/appended' : 'validate/none');
    log(`  ${m.iso} ${m.time} ${m.bu.padEnd(6)} ${m.runId}  status=${m.status}  appended=${m.appended ?? ''}  [${live}]${m.dupCoarse ? '  (a block for this date+BU already exists — verify)' : ''}`);
    if (m.rejectionReasons) log(`        idle/rejected: ${String(m.rejectionReasons).slice(0, 120)}`);
    if (m.error) log(`        error: ${String(m.error).slice(0, 120)}`);
  }
  log(`\nReconstruction note: LIVE runs need the Odoo RFQ list for PO numbers; TEST/validate/none runs can be backfilled from these fields (PASS PR numbers are not stored in the sheet).`);
})();
