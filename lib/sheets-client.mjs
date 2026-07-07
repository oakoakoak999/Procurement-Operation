/**
 * Shared Google Sheets helpers: authenticated Sheets API client + 2nd tier
 * Vendor cell parsing. Used by odoo_pr_to_po.mjs and promote_vendor_tier2.mjs
 * — one copy instead of two drifting ones.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { log } from './util.mjs';

// Returns an authenticated google.sheets v4 client from the saved OAuth token
// at tokenFile. If the token is missing: with interactive=true, runs the
// one-time browser OAuth flow and saves the token; otherwise fails fast with
// missingTokenMsg — in headless (cron) mode an interactive flow would hang
// forever waiting on a localhost callback no one will ever complete (the hang
// would also never write a FAILED Execute Log row).
export async function getSheetClient({ tokenFile, interactive = false, missingTokenMsg } = {}) {
  const { google } = await import('googleapis');
  const { GDRIVE_CLIENT_ID: clientId, GDRIVE_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret)
    throw new Error('GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET not set in .env');

  const auth = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/callback');

  if (existsSync(tokenFile)) {
    auth.setCredentials(JSON.parse(readFileSync(tokenFile, 'utf8')));
    return google.sheets({ version: 'v4', auth });
  }

  if (!interactive)
    throw new Error(missingTokenMsg || `Google Sheets token missing (${tokenFile}) — run an interactive script once to authorize`);

  // First run only: open browser for OAuth
  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  try { execSync(`start "" "${authUrl}"`, { stdio: 'ignore' }); } catch {}
  log(`\nOpen this URL to authorize Google Sheets access:\n${authUrl}\n`);

  const { createServer } = await import('http');
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost:3000');
      const c = u.searchParams.get('code');
      if (c) { res.end('<h2>Done! You can close this tab.</h2>'); server.close(); resolve(c); }
      else res.end('Waiting...');
    }).listen(3000);
    server.on('error', reject); // e.g. port 3000 already in use — reject instead of crashing uncaught
    log('Waiting for OAuth callback on http://localhost:3000/callback ...');
  });

  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), 'utf8');
  log('Google Sheets token saved → ' + tokenFile);
  return google.sheets({ version: 'v4', auth });
}

// "2nd tier Vendor" cell can hold multiple vendors, "|"-separated, each as
// "<code> <name>" (e.g. "0000000308 บริษัท... - BDF | 0000000918 บริษัท... - 3M").
// Entries without a leading numeric code are matched as name-only.
export function parseTier2Vendors(raw) {
  return (raw || '')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const m = entry.match(/^(\d+)\s+(.*)$/);
      return m ? { code: m[1], name: m[2].trim() } : { code: '', name: entry };
    });
}
