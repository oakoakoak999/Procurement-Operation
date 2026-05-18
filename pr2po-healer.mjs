/**
 * PR2PO Healer — AI diagnostic module for the PR2PO Operator
 * Calls OpenRouter API to diagnose errors, explain in plain English,
 * suggest code fixes, and persist learnings to knowledge.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_FILE = join(__dir, 'knowledge.json');
const SCRIPT_FILE    = join(__dir, 'odoo_psv_supply_pr_to_po.mjs');

// ─── KNOWLEDGE BASE ───────────────────────────────────────────────────────────
function loadKnowledge() {
  if (!existsSync(KNOWLEDGE_FILE)) return {};
  try { return JSON.parse(readFileSync(KNOWLEDGE_FILE, 'utf8')); } catch { return {}; }
}

function saveKnowledge(kb) {
  writeFileSync(KNOWLEDGE_FILE, JSON.stringify(kb, null, 2), 'utf8');
}

function knowledgeKey(stepName, errorType) {
  return `${stepName}__${errorType}`;
}

// ─── LOAD ENV ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!existsSync(envPath)) throw new Error('.env file not found');
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

// ─── CALL OPENROUTER ──────────────────────────────────────────────────────────
async function callAI(systemPrompt, userText, screenshotBase64 = null) {
  loadEnv();
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model  = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';

  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set in .env');

  const userContent = screenshotBase64
    ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
      ]
    : userText;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'PR2PO Operator',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from AI');

  try { return JSON.parse(raw); } catch {
    return { explanation: raw };
  }
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are the diagnostic AI for PR2PO Operator — a Node.js Playwright automation
that logs into Odoo ERP, exports Purchase Requests, and appends them to an Excel log.

The script runs 13 steps in sequence:
1. launchChrome    2. connectAndNavigate   3. selectDatabase
4. login           5. switchBU             6. navigateToPRtoPO
7. removeFilter    8. groupByBuyer         9. clickSupplyBuyer
10. exportXLSX    11. appendToLog         12. checkMinimumOrder   13. cleanup

When given an error, you must respond with ONLY valid JSON in this exact shape:
{
  "explanation": "Plain English summary of what went wrong and why (2-4 sentences). Be specific — mention server names, error codes, what the screenshot shows.",
  "root_cause": "One sentence technical root cause",
  "confidence": "HIGH | MEDIUM | LOW",
  "is_script_fault": true or false,
  "fix_description": "What needs to change to fix this (plain English)",
  "code_fix": "The exact code change needed, or null if not a script issue",
  "apply_next_run": true or false,
  "operator_action": "What the operator should do right now — e.g. WAIT_AND_RETRY, ESCALATE, SKIP_STEP"
}
`.trim();

// ─── DIAGNOSE ─────────────────────────────────────────────────────────────────
export async function diagnoseWithAI({ stepName, errorType, errorMessage, screenshotPath, knownFixes = [] }) {
  const kb  = loadKnowledge();
  const key = knowledgeKey(stepName, errorType);

  // Check knowledge base first
  if (kb[key] && kb[key].successCount > 0) {
    console.log(`[HEALER] Known fix found in knowledge base for ${key}`);
    return { ...kb[key], fromKnowledge: true };
  }

  // Take screenshot if path provided
  let screenshotBase64 = null;
  if (screenshotPath && existsSync(screenshotPath)) {
    screenshotBase64 = readFileSync(screenshotPath).toString('base64');
  }

  // Read failing step source from script
  let stepSource = '';
  try {
    const scriptContent = readFileSync(SCRIPT_FILE, 'utf8');
    const stepRegex = new RegExp(`async function ${stepName}[\\s\\S]*?^}`, 'm');
    const match = scriptContent.match(stepRegex);
    if (match) stepSource = match[0];
  } catch {}

  const userText = [
    `STEP THAT FAILED: ${stepName}`,
    `ERROR TYPE: ${errorType}`,
    `ERROR MESSAGE: ${errorMessage}`,
    stepSource ? `\nFAILING STEP SOURCE CODE:\n\`\`\`js\n${stepSource}\n\`\`\`` : '',
    knownFixes.length ? `\nPAST FIXES TRIED:\n${JSON.stringify(knownFixes, null, 2)}` : '',
    screenshotBase64 ? '\nScreenshot of the browser at time of failure is attached.' : '',
  ].filter(Boolean).join('\n');

  const result = await callAI(SYSTEM_PROMPT, userText, screenshotBase64);
  result.stepName  = stepName;
  result.errorType = errorType;
  result.key       = key;
  return result;
}

// ─── RECORD SUCCESS ───────────────────────────────────────────────────────────
export function recordSuccess(diagnosis) {
  if (!diagnosis?.key) return;
  const kb = loadKnowledge();
  const existing = kb[diagnosis.key] || {};
  kb[diagnosis.key] = {
    ...diagnosis,
    successCount: (existing.successCount || 0) + 1,
    lastSuccess:  new Date().toISOString().slice(0, 10),
    fromKnowledge: undefined,
  };
  saveKnowledge(kb);
  console.log(`[HEALER] Fix recorded to knowledge.json → ${diagnosis.key}`);
}

// ─── RECORD FAILURE ───────────────────────────────────────────────────────────
export function recordFailure(diagnosis) {
  if (!diagnosis?.key) return;
  const kb = loadKnowledge();
  const existing = kb[diagnosis.key] || {};
  kb[diagnosis.key] = {
    ...diagnosis,
    failCount:  (existing.failCount || 0) + 1,
    lastFailed: new Date().toISOString().slice(0, 10),
  };
  saveKnowledge(kb);
}
