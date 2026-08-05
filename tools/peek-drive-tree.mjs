#!/usr/bin/env node
/**
 * peek-drive-tree.mjs — read-only view of one BU's uploaded day folder.
 *
 * Answers the two questions the year/month/day + content-hash change raises:
 * did the date folders actually get created, and does every uploaded file
 * carry its content hash? A file without a hash is a file the next run has to
 * download to identify, so "with hash" should equal "files".
 *
 * Usage: node tools/peek-drive-tree.mjs [--bu PSV] [--date 2026-05-05]
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { BU_ORDER_FOLDERS } from '../lib/config.mjs';
import { loadEnv } from '../lib/util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const BU   = arg('--bu', 'PSV');
const DATE = arg('--date', '2026-05-05');

// Must mirror stageUpload's folder naming exactly, or this reports MISSING for
// folders that are actually there.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const [yy, mm, dd] = DATE.split('-');
const Y = yy;
const M = `${mm}.${MONTHS[Number(mm) - 1]}`;   // "08.August" — stageUpload prefixes the number
const D = `${dd}/${mm}/${yy}`;

const TOKEN = join(ROOT, '.gdrive-po-token.json');
if (!existsSync(TOKEN)) throw new Error('No .gdrive-po-token.json — authorize by running the pipeline once');

const auth = new google.auth.OAuth2(
  process.env.GDRIVE_CLIENT_ID, process.env.GDRIVE_CLIENT_SECRET, 'http://localhost:3000/callback');
auth.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf8')));
const drive = google.drive({ version: 'v3', auth });
const A = { supportsAllDrives: true, includeItemsFromAllDrives: true };

const child = async (name, parent) => {
  const r = await drive.files.list({
    q: `'${parent}' in parents and name=${JSON.stringify(name)} and trashed=false`,
    fields: 'files(id,name)', ...A });
  return r.data.files[0];
};

const kids = async parent => {
  const out = []; let t = null;
  do {
    const r = await drive.files.list({
      q: `'${parent}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,appProperties)', pageSize: 1000, ...A,
      ...(t ? { pageToken: t } : {}) });
    out.push(...r.data.files); t = r.data.nextPageToken;
  } while (t);
  return out;
};

const order = BU_ORDER_FOLDERS[BU];
if (!order) throw new Error(`No Drive order folder configured for BU ${BU}`);

const y = await child(Y, order);
const m = y && await child(M, y.id);
const d = m && await child(D, m.id);

console.log(`${BU}  ${order}`);
console.log(`  ${Y} : ${y ? y.id : 'MISSING'}`);
console.log(`  ${M} : ${m ? m.id : 'MISSING'}`);
console.log(`  ${D} : ${d ? d.id : 'MISSING'}`);

if (!d) { console.log('\nDay folder does not exist yet.'); process.exit(0); }

const vendors = (await kids(d.id)).filter(v => v.mimeType === 'application/vnd.google-apps.folder');
let files = 0, hashed = 0;
for (const v of vendors) {
  const f = (await kids(v.id)).filter(x => x.mimeType !== 'application/vnd.google-apps.folder');
  files  += f.length;
  hashed += f.filter(x => x.appProperties?.poContentHash).length;
}
console.log(`\nvendor folders: ${vendors.length}   files: ${files}   with content hash: ${hashed}`);
if (files !== hashed) console.log(`WARNING: ${files - hashed} file(s) have no hash — next run must download them to identify`);
