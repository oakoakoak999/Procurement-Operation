// Shared helpers for procurement pipeline scripts.
import { readFileSync, existsSync } from 'fs';

// Load KEY=VALUE pairs from a .env file into process.env (no overwrite of pre-set vars).
export function loadEnv(envPath) {
  if (!existsSync(envPath)) return;
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

// Timestamped console log. log('msg') or log('STAGE', 'msg').
export function log(a, b) {
  const prefix = `[${new Date().toLocaleTimeString()}]`;
  if (b === undefined) console.log(`${prefix} ${a}`);
  else console.log(`${prefix} [${a}] ${b}`);
}

// Run id like 20260707-1430 for output folders / log rows.
export function makeRunId() {
  const n = new Date(), p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
}

// Cloudflare Access service-token headers, for reaching Odoo (behind Cloudflare
// Access) from an untrusted datacenter/cloud IP. Returns {} when the token env
// vars aren't set — i.e. on a Cloudflare-trusted inside-network machine, where
// the headers aren't needed — so passing this straight to
// browser.newContext({ extraHTTPHeaders }) is a safe no-op locally.
//
// Naming: the bare CF_ACCESS_CLIENT_ID / _SECRET pair is UAT. Production uses
// the _PROD suffix. The asymmetry is deliberate — the bare pair predates any
// production access and renaming it would mean re-issuing a working token,
// since neither GitHub nor Cloudflare will show you a secret's value twice.
//
// There is no fallback between environments in either direction. Sending the
// UAT token at production would fail closed anyway (Cloudflare rejects a token
// that isn't in the prod policy), but it would fail with a 403 that looks like
// a policy problem rather than the missing-secret problem it actually is.
export function cfAccessHeaders(env = 'uat') {
  const suffix = env === 'prod' ? '_PROD' : '';
  // Trimmed: a token pasted into GitHub's secret field usually carries a
  // trailing newline, and Chrome rejects the entire header block with
  // "Invalid header value" at newPage() — before a request is ever sent, so it
  // surfaces as a browser error with no mention of Cloudflare. Whitespace-only
  // collapses to '' and is treated as absent, same as unset.
  const id     = process.env[`CF_ACCESS_CLIENT_ID${suffix}`]?.trim();
  const secret = process.env[`CF_ACCESS_CLIENT_SECRET${suffix}`]?.trim();
  return id && secret
    ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }
    : {};
}
