// Proves findOrCreateFolder reconciles a folder race, by reproducing the exact
// condition that produced three `07.July` folders under PPAT on 2026-07-28:
// several callers asking for the same not-yet-existing folder at once.
//
// A normal pipeline run cannot test this. It only ever hits the "already
// exists" path and returns on the first list, so the election and cleanup code
// never executes -- which is why that branch shipped unproven.
//
// Writes only a throwaway folder under the BU's order folder and trashes it
// again, so the real year/month/day tree is never touched.
//
//   node tools/probe-folder-race.mjs [BU] [lanes]
//
// PASS = exactly one folder survives AND every caller was handed that same id.
// One folder with callers holding different ids would be just as broken: the
// losers would be uploading into something already in the trash.
import { google } from 'googleapis';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/util.mjs';
import { findOrCreateFolder } from '../po-daily-pipeline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

const BU    = process.argv[2] || 'PPRP';
const LANES = Number(process.argv[3] || 5);

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const PARENT = config.buOrderFolders?.[BU];
if (!PARENT) throw new Error(`no order folder configured for ${BU}`);

const TOKEN_FILE = join(ROOT, '.gdrive-po-token.json');
if (!existsSync(TOKEN_FILE)) throw new Error('no saved Drive token — run the pipeline once first');

const auth = new google.auth.OAuth2(
  process.env.GDRIVE_CLIENT_ID, process.env.GDRIVE_CLIENT_SECRET, 'http://localhost:3000/callback');
auth.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));
const drive = google.drive({ version: 'v3', auth });

const NAME = `__probe-folder-race-${Date.now()}`;
console.log(`${LANES} lanes racing for "${NAME}" under ${BU}`);

// Promise.all rather than a loop: they have to be in flight together, or each
// call simply finds the previous one's folder and the race never happens.
const ids = await Promise.all(
  Array.from({ length: LANES }, () => findOrCreateFolder(drive, NAME, PARENT)));

const res = await drive.files.list({
  q: `name='${NAME}' and mimeType='application/vnd.google-apps.folder' and ` +
     `'${PARENT}' in parents and trashed=false`,
  fields: 'files(id,createdTime)', supportsAllDrives: true, includeItemsFromAllDrives: true,
});
const live = res.data.files ?? [];
const unique = [...new Set(ids)];

console.log(`ids handed out : ${unique.length} distinct -> ${unique.join(' ')}`);
console.log(`folders live   : ${live.length}`);

// Clean up whatever survived, pass or fail, so a failed probe does not leave
// litter that the next probe would have to reason about.
for (const f of live) {
  await drive.files.update({
    fileId: f.id, requestBody: { trashed: true }, fields: 'id', supportsAllDrives: true });
}
console.log(`cleaned up ${live.length} folder(s)`);

const pass = unique.length === 1 && live.length === 1 && live[0].id === unique[0];
console.log(pass
  ? 'PASS — one folder survived and every lane agreed on it'
  : 'FAIL — race not reconciled');
process.exit(pass ? 0 : 1);
