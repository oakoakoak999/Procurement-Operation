#!/usr/bin/env node
/**
 * rename-month-folders.mjs — migrate Drive month folders "January" → "01.January".
 *
 * One-shot migration for the naming change of 2026-07-27. Folders created before
 * that change are bare month names, which Drive sorts alphabetically (April,
 * August, December...). Everything created after is "NN.Name".
 *
 * Renames IN PLACE via files.update, which keeps the folder ID. That is the whole
 * reason this is safe: children are not touched, moved, or re-uploaded, share
 * links keep working, and nothing is deleted. A rename is the only write.
 *
 * Idempotent — already-migrated folders are skipped, so re-running is harmless.
 *
 * Usage:
 *   node tools/rename-month-folders.mjs            # dry run, prints the plan
 *   node tools/rename-month-folders.mjs --apply    # perform the renames
 *   node tools/rename-month-folders.mjs --bu PSV   # limit to one BU
 */

import { google } from 'googleapis';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { loadEnv } from '../lib/util.mjs';
import { BU_ORDER_FOLDERS } from '../lib/config.mjs';

const __dir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(__dir, '.env'));

const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const ONLY  = arg('--bu');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = n => String(n).padStart(2, '0');
const TARGET = Object.fromEntries(MONTHS.map((m, i) => [m, `${pad2(i + 1)}.${m}`]));

const TOKEN_FILE = join(__dir, '.gdrive-token.json');

async function authorize() {
  const { GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET } = process.env;
  if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET)
    throw new Error('GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET not set in .env');
  if (!existsSync(TOKEN_FILE))
    throw new Error(`no saved token at ${TOKEN_FILE} — run the pipeline once first`);

  const auth = new google.auth.OAuth2(GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, 'http://localhost:5858/oauth2callback');
  auth.on('tokens', tokens => {
    const saved = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : {};
    writeFileSync(TOKEN_FILE, JSON.stringify({ ...saved, ...tokens }, null, 2));
  });
  auth.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));
  return auth;
}

const listFolders = async (drive, parent) => (await drive.files.list({
  q: `'${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  fields: 'files(id,name)',
  pageSize: 200,
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
})).data.files || [];

(async () => {
  const drive = google.drive({ version: 'v3', auth: await authorize() });

  const bus = Object.entries(BU_ORDER_FOLDERS).filter(([bu]) => !ONLY || bu === ONLY.toUpperCase());
  if (!bus.length) throw new Error(`unknown or blocked BU: ${ONLY}`);

  console.log(`[RENAME] ${APPLY ? 'APPLY' : 'DRY RUN'} | ${bus.length} BU(s)\n`);
  let planned = 0, done = 0, conflicts = 0;

  for (const [bu, orderFolder] of bus) {
    let years;
    try {
      years = await listFolders(drive, orderFolder);
    } catch (e) {
      console.log(`  ${bu}: cannot list order folder — ${e.message}`);
      continue;
    }

    for (const year of years.filter(y => /^\d{4}$/.test(y.name))) {
      const months = await listFolders(drive, year.id);
      const names = new Set(months.map(m => m.name));

      for (const folder of months) {
        const want = TARGET[folder.name];
        if (!want) continue;   // already "NN.Name", or not a month folder at all

        // A folder of the target name already existing means a split: some dates
        // filed under the old name, some under the new. Renaming would leave two
        // same-named folders and silently divide the month, so this stops and
        // reports instead. Merging is a move of every child and is deliberately
        // not automated here.
        if (names.has(want)) {
          console.log(`  ${bu} ${year.name}: CONFLICT — both "${folder.name}" and "${want}" exist, skipped`);
          conflicts++;
          continue;
        }

        planned++;
        if (!APPLY) {
          console.log(`  ${bu} ${year.name}: "${folder.name}" → "${want}"`);
          continue;
        }
        await drive.files.update({ fileId: folder.id, requestBody: { name: want }, supportsAllDrives: true });
        console.log(`  ${bu} ${year.name}: "${folder.name}" → "${want}" ✓`);
        done++;
      }
    }
  }

  console.log(`\n[RENAME] ${APPLY ? `${done} renamed` : `${planned} to rename (dry run — pass --apply)`}` +
    (conflicts ? ` | ${conflicts} CONFLICT(S) need manual merge` : ''));
})();
