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
