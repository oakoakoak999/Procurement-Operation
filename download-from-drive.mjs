/**
 * download-from-drive.mjs — Pull Obsidian Vault from Google Drive to home PC local folder.
 * Run at the START of a home PC session to get notes written on the company PC.
 * Uses the same OAuth token as upload-logs.mjs (.gdrive-token.json).
 *
 * Usage: node download-from-drive.mjs
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { URL } from 'url';
import { hostname } from 'os';
import { pipeline } from 'stream/promises';

const __dir     = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dir, '.gdrive-token.json');
const REDIRECT   = 'http://localhost:3000/callback';

const DRIVE_VAULT_FOLDER_ID = '1ZCkcEF3H-5BSh1fHGchmDNsEMO2DHhRt';
const LOCAL_VAULT_DIR       = 'C:\\Users\\uSeR\\Desktop\\Obsidian Vault';

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
async function listChildren(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 1000,
  });
  return res.data.files;
}

// ─── RECURSIVE DOWNLOAD ───────────────────────────────────────────────────────
async function downloadDirRecursive(drive, driveFolderId, localDir, stats) {
  if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });

  const children = await listChildren(drive, driveFolderId);

  for (const item of children) {
    const localPath = join(localDir, item.name);

    if (item.mimeType === 'application/vnd.google-apps.folder') {
      await downloadDirRecursive(drive, item.id, localPath, stats);
    } else {
      const dest = createWriteStream(localPath);
      const res  = await drive.files.get(
        { fileId: item.id, alt: 'media' },
        { responseType: 'stream' }
      );
      await pipeline(res.data, dest);
      stats.downloaded++;
      if (stats.downloaded % 10 === 0)
        console.log(`[GDRIVE] Downloaded ${stats.downloaded} files so far...`);
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (hostname().toUpperCase() !== 'DESKTOP-KE76UMA') {
      console.log('[GDRIVE] Not home PC — skipping download (vault already on Drive).');
      process.exit(0);
    }

    const auth  = await authorize();
    const drive = google.drive({ version: 'v3', auth });

    console.log('[GDRIVE] Syncing vault from Drive to local...');
    const stats = { downloaded: 0 };
    await downloadDirRecursive(drive, DRIVE_VAULT_FOLDER_ID, LOCAL_VAULT_DIR, stats);
    console.log(`[GDRIVE] Done: ${stats.downloaded} files downloaded.`);

  } catch (err) {
    console.error('[GDRIVE]', err.message);
    process.exit(1);
  }
})();
