/**
 * Pushes the agent memory folder (Decision Log, leftover tracking) to GitHub
 * so decisions made on one machine are visible on the other immediately.
 * Warn-never-fail: by the time this runs the real action (Odoo click, sheet
 * write) already happened, so a git problem must not fail the run.
 *
 * NOT safe from concurrent processes (git index lock, push races) — the
 * one-at-a-time human tools call it per run; batch runs must call it ONCE
 * at the end (run-batch.mjs), never from inside parallel pipeline processes.
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const REPO_DIR   = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_DIR = 'agents/procurement-operator/memory';

export function syncMemoryFolder(message) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: REPO_DIR, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    git('add', MEMORY_DIR);
    if (!git('diff', '--cached', '--name-only')) return; // nothing new (e.g. dry run)
    // Commit BEFORE pulling: the decision is then safe in a local commit even
    // if pull/push fail (next successful sync carries it up). Merge, not
    // rebase — both machines append rows, and a merge keeps both.
    // Identity is set per-commit (not global) so this works on a bare cloud
    // runner, which has none. Attributed to the Actions bot — these commits are
    // machine-written by the pipeline, not by whoever's PC it ran on, so the
    // audit trail stays honest and consistent across local and cloud runs.
    git('-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', message);
    git('pull', '--no-rebase');
    git('push');
    console.log(`[MEMORY-SYNC] Pushed: ${message}`);
  } catch (e) {
    console.warn(`⚠ Memory folder git sync failed (decision is still saved locally): ${e.message}`);
  }
}
