// Append-only audit trail of real human decisions. One markdown table row
// per decision, stamped with date, time, machine name, and Windows user.
// Written by odoo_pr_action.mjs (APPROVE / REJECT, one row per PR) and
// promote_vendor_tier2.mjs (TIER2-PROMOTE) — real (non --test) runs only.
import { existsSync, appendFileSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const LOG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..',
  'agents', 'procurement-operator', 'memory', 'Decision Log.md');

const HEADER = `# Decision Log

Append-only audit trail of every real (non --test) decision executed through
the scripts. Rows are written automatically — do not edit or remove them.
APPROVE / REJECT come from odoo_pr_action.mjs (one row per PR);
TIER2-PROMOTE comes from promote_vendor_tier2.mjs (reference-sheet whitelist
write that makes the vendor auto-pass in future runs).

| Date | Time | PC | User | Event | Profile | BU | Detail |
|------|------|----|------|-------|---------|----|--------|
`;

export function appendDecision({ event, profile = '-', bu, detail }) {
  const n = new Date(), p = v => String(v).padStart(2, '0');
  const date = `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
  const time = `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
  const user = process.env.USERNAME || process.env.USER || '-';
  // "|" would break the markdown table row
  const clean = v => String(v).replace(/\|/g, '/');
  const row = `| ${date} | ${time} | ${clean(hostname())} | ${clean(user)} | ${event} | ${clean(profile)} | ${clean(bu)} | ${clean(detail)} |\n`;
  if (!existsSync(LOG_PATH)) writeFileSync(LOG_PATH, HEADER);
  appendFileSync(LOG_PATH, row);
}
