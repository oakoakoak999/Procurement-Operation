#!/usr/bin/env node
// PDF count per BU per day for a set of dates, read straight from Drive.
// Each day is also broken down by upload date (Drive createdTime), which is what
// separates an intraday sweep from the next morning's `30 0` yesterday sweep.
// Read-only. Promoted from a throwaway (tmp-daycount.mjs) on 2026-08-05.
// Usage: node tools/drive-day-census.mjs --dates 2026-08-03,2026-08-04,2026-08-05

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BU_ORDER_FOLDERS } from '../lib/config.mjs';
import { loadEnv } from '../lib/util.mjs';

const ROOT = join(process.env.USERPROFILE, 'Desktop', 'Procurement Operator');
loadEnv(join(ROOT, '.env'));

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const DATES = arg('--dates', '2026-08-03,2026-08-04,2026-08-05').split(',');

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const auth = new google.auth.OAuth2(
  process.env.GDRIVE_CLIENT_ID, process.env.GDRIVE_CLIENT_SECRET, 'http://localhost:3000/callback');
auth.setCredentials(JSON.parse(readFileSync(join(ROOT, '.gdrive-po-token.json'), 'utf8')));
const drive = google.drive({ version: 'v3', auth });
const A = { supportsAllDrives: true, includeItemsFromAllDrives: true };

const kids = async parent => {
  const out = []; let t = null;
  do {
    const r = await drive.files.list({
      q: `'${parent}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,createdTime)',
      pageSize: 1000, ...A, ...(t ? { pageToken: t } : {}) });
    out.push(...r.data.files); t = r.data.nextPageToken;
  } while (t);
  return out;
};
const child = async (name, parent) => {
  const r = await drive.files.list({
    q: `'${parent}' in parents and name=${JSON.stringify(name)} and trashed=false`,
    fields: 'files(id,name)', ...A });
  return r.data.files[0];
};

async function dayStats(root, date) {
  const [yy, mm, dd] = date.split('-');
  const M = `${mm}.${MONTHS[Number(mm) - 1]}`;
  const y = await child(yy, root);            if (!y) return null;
  const m = await child(M, y.id);             if (!m) return null;
  const d = await child(`${dd}/${mm}/${yy}`, m.id); if (!d) return null;
  const top = await kids(d.id);
  const files = top.filter(x => x.mimeType !== 'application/vnd.google-apps.folder');
  const vend  = top.filter(x => x.mimeType === 'application/vnd.google-apps.folder');
  const all = [...files];
  for (const v of vend) {
    all.push(...(await kids(v.id)).filter(x => x.mimeType !== 'application/vnd.google-apps.folder'));
  }
  const byDay = {};
  for (const f of all) (byDay[f.createdTime.slice(0, 10)] ||= []).push(f);
  return { n: all.length, byDay };
}

const bus = Object.keys(BU_ORDER_FOLDERS).sort();
const results = await Promise.all(bus.map(async bu => {
  const row = { bu, cells: {} };
  for (const dt of DATES) {
    try { row.cells[dt] = await dayStats(BU_ORDER_FOLDERS[bu], dt); }
    catch (e) { row.cells[dt] = { err: e.message }; }
  }
  return row;
}));

const w = 12;
console.log('BU'.padEnd(8) + DATES.map(d => d.padEnd(w)).join(''));
let tot = {};
for (const r of results) {
  const cells = DATES.map(d => {
    const c = r.cells[d];
    if (!c) return '-'.padEnd(w);
    if (c.err) return 'ERR'.padEnd(w);
    tot[d] = (tot[d] || 0) + c.n;
    return String(c.n).padEnd(w);
  });
  console.log(r.bu.padEnd(8) + cells.join(''));
}
console.log('-'.repeat(8 + DATES.length * w));
console.log('TOTAL'.padEnd(8) + DATES.map(d => String(tot[d] || 0).padEnd(w)).join(''));

console.log('\n--- upload-date breakdown per BU/day (which sweep put it there) ---');
for (const r of results) {
  for (const d of DATES) {
    const c = r.cells[d];
    if (!c || c.err || !c.n) continue;
    const parts = Object.keys(c.byDay).sort().map(k => `${k}:${c.byDay[k].length}`).join('  ');
    console.log(`${r.bu.padEnd(8)} ${d}  n=${String(c.n).padStart(4)}   ${parts}`);
  }
}
