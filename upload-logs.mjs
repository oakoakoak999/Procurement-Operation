/**
 * upload-logs.mjs — Sync Obsidian Vault .md files to Google Drive
 * First run: opens browser for one-time OAuth, saves token locally
 * Always replaces existing files (content may have changed, name stays same)
 *
 * Setup (one-time):
 *   1. GCP Console → Enable Drive API → Create OAuth 2.0 credentials (Desktop app)
 *   2. Add to .env:  GDRIVE_CLIENT_ID=...  GDRIVE_CLIENT_SECRET=...
 *   3. Run once: node upload-logs.mjs  (browser opens for auth)
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { URL } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE  = join(__dir, '.gdrive-token.json');
const REDIRECT    = 'http://localhost:3000/callback';


// ─── ENV ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!existsSync(envPath)) return;
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function getOAuth2Client() {
  loadEnv();
  const { GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET } = process.env;
  if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET)
    throw new Error('Add GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET to .env');
  return new google.auth.OAuth2(GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, REDIRECT);
}

async function authorize() {
  const auth = getOAuth2Client();

  if (existsSync(TOKEN_FILE)) {
    auth.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));
    auth.on('tokens', tokens => {
      const saved = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
      writeFileSync(TOKEN_FILE, JSON.stringify({ ...saved, ...tokens }, null, 2));
    });
    return auth;
  }

  // First-time OAuth flow
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
  });

  console.log('\n[GDRIVE] First-time setup. Open this URL in your browser:');
  console.log('\n' + url + '\n');
  console.log('Waiting for authorization (5 min timeout)...\n');

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost:3000');
      if (u.pathname === '/callback') {
        res.end('<h1>Authorized! You can close this tab.</h1>');
        server.close();
        resolve(u.searchParams.get('code'));
      }
    });
    server.listen(3000);
    setTimeout(() => { server.close(); reject(new Error('Auth timeout')); }, 300_000);
  });

  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log('[GDRIVE] Token saved — future runs will be silent.\n');
  return auth;
}

// ─── DRIVE HELPERS ────────────────────────────────────────────────────────────
async function findOrCreateFolder(drive, name, parentId = 'root') {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)' });
  if (res.data.files.length) return res.data.files[0].id;
  const f = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return f.data.id;
}

async function getExistingFiles(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name)',
  });
  const map = {};
  for (const f of res.data.files) map[f.name] = f.id;
  return map;
}

// ─── UPLOAD HELPERS ───────────────────────────────────────────────────────────
async function uploadSingleFile(drive, folderId, name, content) {
  const existing = await getExistingFiles(drive, folderId);
  if (existing[name]) {
    await drive.files.update({
      fileId: existing[name],
      media: { mimeType: 'text/plain', body: content },
    });
    return 'replaced';
  } else {
    await drive.files.create({
      requestBody: { name, parents: [folderId] },
      media: { mimeType: 'text/plain', body: content },
      fields: 'id',
    });
    return 'uploaded';
  }
}

// Recursively upload a local directory to a Drive folder, preserving structure.
async function uploadDirRecursive(drive, localDir, driveFolderId, stats) {
  const existing = await getExistingFiles(drive, driveFolderId);
  const entries  = readdirSync(localDir);

  for (const entry of entries) {
    const localPath = join(localDir, entry);
    const stat      = statSync(localPath);

    if (stat.isDirectory()) {
      const subFolderId = await findOrCreateFolder(drive, entry, driveFolderId);
      await uploadDirRecursive(drive, localPath, subFolderId, stats);
    } else {
      if (existing[entry]) {
        await drive.files.update({
          fileId: existing[entry],
          media: { body: createReadStream(localPath) },
        });
        stats.replaced++;
      } else {
        await drive.files.create({
          requestBody: { name: entry, parents: [driveFolderId] },
          media: { body: createReadStream(localPath) },
          fields: 'id',
        });
        stats.uploaded++;
      }
      if ((stats.uploaded + stats.replaced) % 10 === 0)
        console.log(`[GDRIVE] Obsidian: ${stats.uploaded} uploaded, ${stats.replaced} replaced so far...`);
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const auth  = await authorize();
    const drive = google.drive({ version: 'v3', auth });

    loadEnv();
    const VAULT_DIR          = process.env.OBSIDIAN_VAULT_PATH || '';
    const OBSIDIAN_FOLDER_ID = process.env.OBSIDIAN_BRAIN_FOLDER_ID || '';
    const CLAUDE_MD_FILE     = process.env.CLAUDE_MD_PATH;
    const CLAUDE_FOLDER_ID   = process.env.CLAUDE_MD_FOLDER_ID;

    if (!CLAUDE_MD_FILE || !CLAUDE_FOLDER_ID)
      throw new Error('CLAUDE_MD_PATH / CLAUDE_MD_FOLDER_ID not set in .env');

    // 1. Obsidian vault (only if configured in .env)
    if (VAULT_DIR && OBSIDIAN_FOLDER_ID) {
      const stats = { uploaded: 0, replaced: 0 };
      await uploadDirRecursive(drive, VAULT_DIR, OBSIDIAN_FOLDER_ID, stats);
      console.log(`[GDRIVE] Obsidian done: ${stats.uploaded} uploaded, ${stats.replaced} replaced`);
    } else {
      console.log('[GDRIVE] Obsidian: skipped (OBSIDIAN_VAULT_PATH not set in .env)');
    }

    // 2. CLAUDE.md
    const claudeContent = readFileSync(CLAUDE_MD_FILE, 'utf8');
    const result = await uploadSingleFile(drive, CLAUDE_FOLDER_ID, 'CLAUDE.md', claudeContent);
    console.log(`[GDRIVE] CLAUDE.md: ${result}`);

  } catch (err) {
    console.error('[GDRIVE]', err.message);
    process.exit(1);
  }
})();
