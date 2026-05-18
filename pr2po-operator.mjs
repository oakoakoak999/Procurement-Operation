/**
 * PR2PO Operator — Silent supervisor for the Odoo PR→PO pipeline
 * Wakes only when something goes wrong: diagnose, retry from checkpoint, report.
 * Never interrupts a healthy run.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { diagnoseWithAI, recordSuccess, recordFailure } from './pr2po-healer.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_PATH = join(__dir, 'operator-error.png');

import {
  findLogFile,
  launchChrome, connectAndNavigate, selectDatabase,
  login, switchBU, navigateToPRtoPO,
  removeFilter, groupByBuyer, clickSupplyBuyer, exportXLSX,
  appendToLog, checkMinimumOrder, cleanup,
} from './odoo_psv_supply_pr_to_po.mjs';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const MAX_RETRIES    = 3;
const RETRY_BACKOFF  = 3000; // ms × attempt number
const OBSIDIAN_DIR   = `${process.env.USERPROFILE}\\Desktop\\Obsidian Vault\\Claude Log`;

const CP = {
  A: { name: 'A', steps: '1–3',   desc: 'browser + DB ready' },
  B: { name: 'B', steps: '4–6',   desc: 'logged in + BU selected' },
  C: { name: 'C', steps: '7–10',  desc: 'navigation + export' },
  D: { name: 'D', steps: '11–13', desc: 'post-export processing' },
};

// ─── RUN ID ───────────────────────────────────────────────────────────────────
const RUN_ID = (() => {
  const n = new Date(), p = v => String(v).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}`;
})();

// ─── STRUCTURED LOG ───────────────────────────────────────────────────────────
function structuredLog({ step, status, severity, type, message, confidence, checkpoint, recovery, action }) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `[${ts}]`,
    `RUN_ID    : ${RUN_ID}`,
    `STEP      : ${step}`,
    `STATUS    : ${status}`,
    `SEVERITY  : ${severity}`,
  ];
  if (type)       lines.push(`TYPE      : ${type}`);
  if (message)    lines.push(`MESSAGE   : ${message}`);
  if (confidence) lines.push(`CONFIDENCE: ${confidence}`);
  if (checkpoint) lines.push(`CHECKPOINT: ${checkpoint.name} (steps ${checkpoint.steps}) — ${checkpoint.desc}`);
  if (recovery)   lines.push(`RECOVERY  : ${recovery}`);
  if (action)     lines.push(`ACTION    : ${action}`);
  console.log('\n' + lines.join('\n') + '\n');
}

// ─── DIAGNOSE ─────────────────────────────────────────────────────────────────
function diagnose(err) {
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes('timeout'))                          return { severity: 'ERROR', type: 'TimeoutError',      confidence: 'HIGH — element not rendered or page too slow' };
  if (msg.includes('net::') || msg.includes('err_'))   return { severity: 'ERROR', type: 'NetworkError',      confidence: 'HIGH — connectivity issue' };
  if (msg.includes('not found') || msg.includes('cannot read')) return { severity: 'ERROR', type: 'ElementNotFound', confidence: 'MEDIUM — selector may have changed' };
  if (msg.includes('cannot connect') || msg.includes('econnrefused')) return { severity: 'FATAL', type: 'ConnectionError', confidence: 'HIGH — Chrome or Odoo unreachable' };
  return { severity: 'ERROR', type: 'UnknownError', confidence: 'LOW — manual inspection required' };
}

// ─── OBSIDIAN ESCALATION ──────────────────────────────────────────────────────
function escalate(step, err, diagnosis, attempt) {
  structuredLog({ step, status: 'ESCALATED', ...diagnosis, message: err.message, action: `Failed ${attempt}/${MAX_RETRIES} — manual intervention required` });
  try {
    if (!existsSync(OBSIDIAN_DIR)) mkdirSync(OBSIDIAN_DIR, { recursive: true });
    const d = new Date(), p = v => String(v).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
    const timeStr = `${p(d.getHours())}-${p(d.getMinutes())}`;
    const file = join(OBSIDIAN_DIR, `${dateStr} ${timeStr} PR2PO Escalation.md`);
    writeFileSync(file, [
      `# PR2PO Operator Escalation`,
      `- Device: Company Laptop`,
      `- RUN_ID: ${RUN_ID}`,
      `- Step: ${step}`,
      `- Severity: ${diagnosis.severity}`,
      `- Type: ${diagnosis.type}`,
      `- Message: ${err.message}`,
      `- Confidence: ${diagnosis.confidence}`,
      `- Retries: ${attempt}/${MAX_RETRIES}`,
      `- Action: Manual intervention required`,
    ].join('\n'), 'utf8');
    console.log(`[OPERATOR] Escalation written → ${file}`);
  } catch (e) {
    console.error('[OPERATOR] Could not write escalation to Obsidian:', e.message);
  }
}

// ─── CHECKPOINT RUNNER ────────────────────────────────────────────────────────
async function runCheckpoint(name, fn, recovery, page = null) {
  let aiDiagnosis = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let currentStep = '?';
    try {
      const result = await fn(s => { currentStep = s; });
      // If a previous attempt got an AI diagnosis and this attempt succeeded, record it
      if (aiDiagnosis) recordSuccess(aiDiagnosis);
      return result;
    } catch (err) {
      const diagnosis = diagnose(err);
      structuredLog({
        step: currentStep,
        status: 'FAILED',
        ...diagnosis,
        message: err.message,
        checkpoint: CP[name],
        recovery: attempt < MAX_RETRIES ? recovery : 'Max retries reached',
        action: attempt < MAX_RETRIES ? `Retry ${attempt}/${MAX_RETRIES}` : 'ESCALATE',
      });

      if (diagnosis.severity === 'FATAL') {
        escalate(currentStep, err, diagnosis, attempt);
        throw err;
      }

      // On last retry — call AI healer before giving up
      if (attempt === MAX_RETRIES) {
        console.log('\n[HEALER] Calling AI for diagnosis...');
        try {
          // Take screenshot if page is available
          if (page) {
            try { await page.screenshot({ path: SCREENSHOT_PATH }); } catch {}
          }
          const stepName = currentStep.replace(/^\d+\/\d+\s*/, '').replace('↺ ', '');
          aiDiagnosis = await diagnoseWithAI({
            stepName,
            errorType: diagnosis.type,
            errorMessage: err.message,
            screenshotPath: existsSync(SCREENSHOT_PATH) ? SCREENSHOT_PATH : null,
          });

          // Print AI explanation in friendly format
          console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('[AI DIAGNOSIS]');
          console.log(aiDiagnosis.explanation || '(no explanation)');
          if (aiDiagnosis.fix_description) {
            console.log('\n[SUGGESTED FIX]');
            console.log(aiDiagnosis.fix_description);
          }
          if (aiDiagnosis.operator_action) {
            console.log(`\n[RECOMMENDED ACTION] ${aiDiagnosis.operator_action}`);
          }
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

          recordFailure(aiDiagnosis);
        } catch (aiErr) {
          console.error('[HEALER] AI diagnosis failed:', aiErr.message);
        }

        escalate(currentStep, err, diagnosis, attempt);
        throw err;
      }

      await new Promise(r => setTimeout(r, RETRY_BACKOFF * attempt));
    }
  }
}

// ─── CHECKPOINTS ──────────────────────────────────────────────────────────────
async function checkpointA() {
  return runCheckpoint('A', async (track) => {
    track('1/13 launchChrome');      await launchChrome();
    track('2/13 connectAndNavigate');const conn = await connectAndNavigate();
    track('3/13 selectDatabase');    await selectDatabase(conn.page);
    return conn;
  }, 'Restart Checkpoint A — re-launch Chrome and reconnect');
}

async function checkpointB(page) {
  return runCheckpoint('B', async (track) => {
    track('4/13 login');             await login(page);
    track('5/13 switchBU');          await switchBU(page);
    track('6/13 navigateToPRtoPO'); await navigateToPRtoPO(page);
  }, 'Restart Checkpoint B — re-login and switch BU', page);
}

async function checkpointC(page, attempt = 1) {
  return runCheckpoint('C', async (track) => {
    if (attempt > 1) { track('6↺ navigateToPRtoPO'); await navigateToPRtoPO(page); }
    track('7/13 removeFilter');      await removeFilter(page);
    track('8/13 groupByBuyer');      await groupByBuyer(page);
    track('9/13 clickSupplyBuyer'); await clickSupplyBuyer(page);
    track('10/13 exportXLSX');
    const exportPath = await exportXLSX(page);
    if (!exportPath || !existsSync(exportPath)) throw new Error('Export file not created — zero rows or export failed');
    return exportPath;
  }, 'Navigate back to Generate PR to PO, re-run steps 7–10', page);
}

async function checkpointD(exportPath, logPath) {
  return runCheckpoint('D', async (track) => {
    track('11/13 appendToLog');
    const appended = await appendToLog(exportPath, logPath);

    // WARN: zero rows appended
    if (appended === 0) {
      structuredLog({
        step: '11/13 appendToLog', status: 'WARN', severity: 'WARN', type: 'ZeroRows',
        message: 'No new rows appended — all may be duplicates or export was empty',
        confidence: 'MEDIUM — verify SUPPLY_BUYER has pending PRs today',
        action: 'STOPPING — manual check required',
      });
      cleanup(exportPath);
      process.exit(0);
    }

    track('12/13 checkMinimumOrder');
    await checkMinimumOrder(logPath);

    track('13/13 cleanup');
    cleanup(exportPath);
  }, 'Restart Checkpoint D — re-run post-export processing');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  const logPath = process.argv[2] || findLogFile();
  console.log(`[OPERATOR] PR2PO Operator starting — RUN_ID: ${RUN_ID}`);
  console.log(`[OPERATOR] Log file: ${logPath}`);

  let conn;
  try {
    conn = await checkpointA();
    await checkpointB(conn.page);
    const exportPath = await checkpointC(conn.page);
    await checkpointD(exportPath, logPath);

    console.log(`\n[OPERATOR] RUN_ID: ${RUN_ID} — COMPLETED SUCCESSFULLY`);
  } catch (err) {
    console.error(`\n[OPERATOR] RUN_ID: ${RUN_ID} — ABORTED`);
    console.error(`[OPERATOR] ${err.message}`);
    if (conn?.browser) try { await conn.browser.close(); } catch {}
    process.exit(1);
  }

  if (conn?.browser) try { await conn.browser.close(); } catch {}
})();
