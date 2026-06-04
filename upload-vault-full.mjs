/**
 * upload-vault-full.mjs — Upload the entire Obsidian Vault to Google Drive
 * Recursively mirrors folder structure, handles all file types, skips unchanged files.
 * Requires drive scope (broader than upload-logs.mjs) — browser auth on first run only.
 * Token saved separately to .gdrive-vault-token.json.
 */

import { google }                                              from 'googleapis';
import { readFileSync, writeFileSync, existsSync, readdirSync,
         statSync, createReadStream }                          from 'fs';
import { join, dirname, extname }                              from 'path';
import { fileURLToPath }                                       from 'url';
import { createServer }                                        from 'http';
import { URL }                                                 from 'url';

const __dir      = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dir, '.gdrive-vault-token.json');
const REDIRECT   = 'http://localhost:3000/callback';


// ─── ENV ─────────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!existsSync(envPath)) return;
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

// ─── MIME ─────────────────────────────────────────────────────────────────────
function getMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  const map = {
    '.md':      'text/plain',
    '.txt':     'text/plain',
    '.canvas':  'application/json',
    '.json':    'application/json',
    '.css':     'text/css',
    '.js':      'application/javascript',
    '.ts':      'text/plain',
    '.html':    'text/html',
    '.xml':     'text/xml',
    '.svg':     'image/svg+xml',
    '.png':     'image/png',
    '.jpg':     'image/jpeg',
    '.jpeg':    'image/jpeg',
    '.gif':     'image/gif',
    '.webp':    'image/webp',
    '.pdf':     'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
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

  // First-time OAuth — needs drive scope for listing files we didn't create
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive'],
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
async function findOrCreateFolder(drive, name, parentId) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.data.files.length) return res.data.files[0].id;
  const f = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return f.data.id;
}

async function listRemoteFiles(drive, folderId) {
  const map = {};
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      spaces: 'drive',
      pageToken,
    });
    for (const f of res.data.files) map[f.name] = f;
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return map;
}

// ─── RECURSIVE UPLOAD ─────────────────────────────────────────────────────────
const stats = { uploaded: 0, replaced: 0, skipped: 0, folders: 0 };

async function uploadDirectory(drive, localPath, remoteFolderId, depth = 0) {
  const indent    = '  '.repeat(depth);
  const entries   = readdirSync(localPath);
  const remote    = await listRemoteFiles(drive, remoteFolderId);

  for (const entry of entries) {
    const localEntry = join(localPath, entry);
    const stat       = statSync(localEntry);

    if (stat.isDirectory()) {
      process.stdout.write(`${indent}[DIR]  ${entry}/\n`);
      const childId = await findOrCreateFolder(drive, entry, remoteFolderId);
      stats.folders++;
      await uploadDirectory(drive, localEntry, childId, depth + 1);
    } else {
      const mimeType = getMimeType(entry);
      const existing = remote[entry];

      try {
        if (existing) {
          await drive.files.update({
            fileId: existing.id,
            media: { mimeType, body: createReadStream(localEntry) },
          });
          process.stdout.write(`${indent}  [UPD] ${entry}\n`);
          stats.replaced++;
        } else {
          await drive.files.create({
            requestBody: { name: entry, parents: [remoteFolderId] },
            media: { mimeType, body: createReadStream(localEntry) },
            fields: 'id',
          });
          process.stdout.write(`${indent}  [NEW] ${entry}\n`);
          stats.uploaded++;
        }
      } catch (err) {
        process.stdout.write(`${indent}  [ERR] ${entry}: ${err.message}\n`);
      }
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    loadEnv();
    const VAULT_PATH      = process.env.OBSIDIAN_VAULT_PATH;
    const DRIVE_FOLDER_ID = process.env.OBSIDIAN_VAULT_FOLDER_ID || '11de3g5uVMrQJwUeluNpTrPvpCxSOBdbv';
    if (!VAULT_PATH) throw new Error('OBSIDIAN_VAULT_PATH not set in .env');

    console.log('[VAULT] Starting full Obsidian Vault upload...');
    console.log(`[VAULT] Source : ${VAULT_PATH}`);
    console.log(`[VAULT] Target : Drive folder ${DRIVE_FOLDER_ID}\n`);

    const auth  = await authorize();
    const drive = google.drive({ version: 'v3', auth });

    await uploadDirectory(drive, VAULT_PATH, DRIVE_FOLDER_ID);

    console.log('\n[VAULT] Done!');
    console.log(`  Folders  : ${stats.folders}`);
    console.log(`  Uploaded : ${stats.uploaded} new files`);
    console.log(`  Replaced : ${stats.replaced} existing files`);
    console.log(`  Errors   : (see [ERR] lines above)`);
  } catch (err) {
    console.error('\n[VAULT] Fatal:', err.message);
    process.exit(1);
  }
})();
