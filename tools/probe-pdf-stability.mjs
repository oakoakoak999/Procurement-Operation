#!/usr/bin/env node
/**
 * probe-pdf-stability.mjs — is a PO PDF's extracted text stable across renders?
 *
 * Content-aware dedup (the planned replacement for filename-only matching)
 * hashes the extracted text of each split PDF. That only works if two renders
 * of an *unchanged* PO produce identical text. If Odoo stamps a render
 * timestamp, print user, or any other per-render value into the document, the
 * hash inverts: every file mismatches every day and the pipeline re-uploads
 * all 268 of them. So this must be answered before #2 is built, not after.
 *
 * Method: compare a local split PDF (rendered today) against the same PO
 * already on Drive (rendered on an earlier run). Same PO, two renders, days
 * apart — exactly the case dedup has to survive.
 *
 * Read-only: downloads from Drive, writes nothing back.
 *
 * Usage: node tools/probe-pdf-stability.mjs [--bu PSV] [--date 2026-05-05] [--n 5]
 */

import { google } from 'googleapis';
import { createRequire } from 'module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { createHash } from 'crypto';
import { BU_ORDER_FOLDERS } from '../lib/config.mjs';
import { loadEnv } from '../lib/util.mjs';

const require  = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');
loadEnv(join(ROOT, '.env'));

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : dflt;
};
const BU     = arg('--bu', 'PSV');
const DATE   = arg('--date', '2026-05-05');
const SAMPLE = Number(arg('--n', '5'));

const SLUG      = DATE.replace(/-/g, '');
const SPLIT_DIR = join(homedir(), 'Downloads', `PO-${BU}-Split-${SLUG}`);
const TMP       = join(tmpdir(), 'po-pdf-stability');
const TOKEN     = join(ROOT, '.gdrive-po-token.json');

const sha = s => createHash('sha256').update(s).digest('hex');

// Whitespace differs harmlessly between extractions; the hash we would ship
// normalizes it, so the probe must test the normalized form, not the raw one.
const norm = s => s.replace(/\s+/g, ' ').trim();

async function auth() {
  const { GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET } = process.env;
  if (!existsSync(TOKEN)) throw new Error('No .gdrive-po-token.json — run the pipeline once to authorize');
  const a = new google.auth.OAuth2(GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, 'http://localhost:3000/callback');
  a.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf8')));
  return a;
}

const DRIVE_ARGS = { supportsAllDrives: true, includeItemsFromAllDrives: true };

async function findChild(drive, name, parent) {
  const q = `'${parent}' in parents and name = ${JSON.stringify(name)} and trashed = false`;
  const r = await drive.files.list({ q, fields: 'files(id,name)', ...DRIVE_ARGS });
  return r.data.files[0] ?? null;
}

async function listChildren(drive, parent, extraQ = '') {
  const q = `'${parent}' in parents and trashed = false${extraQ}`;
  const r = await drive.files.list({
    q, fields: 'files(id,name,size,mimeType,modifiedTime)', pageSize: 1000, ...DRIVE_ARGS,
  });
  return r.data.files;
}

async function download(drive, id, dest) {
  const r = await drive.files.get({ fileId: id, alt: 'media', ...DRIVE_ARGS },
                                  { responseType: 'arraybuffer' });
  const buf = Buffer.from(r.data);
  writeFileSync(dest, buf);
  return buf;
}

(async () => {
  mkdirSync(TMP, { recursive: true });
  if (!existsSync(SPLIT_DIR)) throw new Error(`No local split dir: ${SPLIT_DIR}`);

  const drive = google.drive({ version: 'v3', auth: await auth() });
  const order = BU_ORDER_FOLDERS[BU];
  if (!order) throw new Error(`No Drive order folder configured for BU ${BU}`);

  const year = DATE.slice(0, 4);
  const yearFolder = await findChild(drive, year, order);
  if (!yearFolder) throw new Error(`Year folder ${year} not found under ${order}`);
  console.log(`Drive: ${order}/${year} → ${yearFolder.id}`);

  // Walk local vendor dirs and pair each PDF with its Drive twin.
  const vendorDirs = readdirSync(SPLIT_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  const pairs = [];
  for (const vendor of vendorDirs) {
    if (pairs.length >= SAMPLE) break;
    const remoteVendor = await findChild(drive, vendor, yearFolder.id);
    if (!remoteVendor) { console.log(`  (no Drive folder for vendor "${vendor}") `); continue; }
    const remoteFiles = await listChildren(drive, remoteVendor.id);
    const localPdfs = readdirSync(join(SPLIT_DIR, vendor)).filter(f => f.toLowerCase().endsWith('.pdf'));
    for (const f of localPdfs) {
      if (pairs.length >= SAMPLE) break;
      const twin = remoteFiles.find(r => r.name === f);
      if (twin) pairs.push({ vendor, name: f, local: join(SPLIT_DIR, vendor, f), remote: twin });
    }
  }

  if (!pairs.length) throw new Error('No local/Drive filename pairs found — nothing to compare');

  console.log(`\nComparing ${pairs.length} PO(s): local render (today) vs Drive render (earlier run)\n`);

  let identical = 0;
  const diffs = [];

  for (const p of pairs) {
    const localBuf  = readFileSync(p.local);
    const remoteBuf = await download(drive, p.remote.id, join(TMP, `drive-${p.name}`));

    const [lt, rt] = await Promise.all([pdfParse(localBuf), pdfParse(remoteBuf)]);
    const L = norm(lt.text), R = norm(rt.text);
    const same = L === R;
    if (same) identical++;

    console.log(`${same ? 'SAME' : 'DIFF'}  ${p.name}  (${p.vendor.slice(0, 28)})`);
    console.log(`      bytes  local ${localBuf.length}  drive ${p.remote.size}  ` +
                `(${localBuf.length === Number(p.remote.size) ? 'equal' : 'differ'})`);
    console.log(`      text   local ${sha(L).slice(0, 16)}  drive ${sha(R).slice(0, 16)}`);
    console.log(`      drive modifiedTime ${p.remote.modifiedTime}`);

    if (!same) {
      // Show where they diverge — a lone timestamp is a fixable problem
      // (strip it before hashing); scattered differences are not.
      const a = L.split(' '), b = R.split(' ');
      const out = [];
      for (let i = 0, j = 0; (i < a.length || j < b.length) && out.length < 8; i++, j++) {
        if (a[i] !== b[j]) out.push(`        @${i}  local="${a[i]}"  drive="${b[j]}"`);
      }
      console.log(out.join('\n') || '        (differ only in length)');
      console.log(`      token count  local ${a.length}  drive ${b.length}`);
      diffs.push(p.name);
    }
    console.log('');
  }

  console.log('─'.repeat(70));
  console.log(`RESULT: ${identical}/${pairs.length} identical after whitespace normalization`);
  console.log(identical === pairs.length
    ? 'Text is stable across renders → content hashing is safe.'
    : `Text is NOT stable → hashing would re-upload on every run. Differing: ${diffs.join(', ')}`);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
