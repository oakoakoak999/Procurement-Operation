# Procurement Operator — Instructions

## Memory Architecture

| Type | File | Purpose |
|------|------|---------|
| Semantic | `C:\Users\uSeR\.claude\agents\procurement-operator.md` | Agent identity, context, rules |
| Procedural | `C:\Users\uSeR\.claude\agents\procurement-operator\SKILL.md` | How to act (this file) |
| Episodic | `C:\Users\uSeR\.claude\agent-memory\procurement-operator\` | Past run history |

**Episodic RAG flow:**
1. Always read `Memory.md` index first (brief — one row per day)
2. Pull only daily files relevant to the current context (e.g., same error pattern, same profile/BU)
3. Never read all episode files blindly

---

## Tools
- `C:\Users\uSeR\Desktop\Claude Code\odoo_pr_to_po.mjs` — core automation + operator (single entry point)

Run from `C:\Users\uSeR\Desktop\Claude Code\` (node_modules live here)

## Profiles
| Profile key | Buyer in Odoo | GSheet log tab |
|-------------|---------------|----------------|
| `supply`    | SUPPLY_BUYER  | MEDSUPPLY      |
| `medicine`  | MEDICINE_BUYER| MEDICINE       |

## Natural language → command
| User says | Run command |
|-----------|-------------|
| "run PR2PO" / "run supply on PSV" | `node odoo_pr_to_po.mjs supply PSV` |
| "run medicine on PSV" | `node odoo_pr_to_po.mjs medicine PSV` |
| "run supply on PSUV" | `node odoo_pr_to_po.mjs supply PSUV` |
| "run medicine on PSUV" | `node odoo_pr_to_po.mjs medicine PSUV` |
| Any BU + any profile | `node odoo_pr_to_po.mjs <profile> <BU_CODE>` |

Both args are required — the script errors if either is missing.

---

## On every invocation
1. Read episodic `Memory.md` index — pull relevant daily files if any
2. Parse the user's request to determine profile and BU code
3. Run `node odoo_pr_to_po.mjs <profile> <BU_CODE>` from `C:\Users\uSeR\Desktop\Claude Code\`
4. Capture stdout/stderr and the exit code
5. Write episodic memory (see below)
6. Branch on outcome

---

## If the run SUCCEEDS (exit code 0)
Report in this format — nothing more:
```
✓ RUN_ID <id> — <N> rows appended

Rejected (minimum order):
  • <PR number> — <item name> — <value> THB (min: <threshold> THB, short by <gap> THB)
  (or "None")

Rejected (vendor):
  • <PR number> — <item name> — expected: <vendor>, got: <actual>
  (or "None")

Log: <path>
```
Read the log output to extract rejected PR details. Do not analyze, suggest improvements, or recap steps.

---

## If the run FAILS (non-zero exit or unhandled exception)
Switch to active healer mode:

**1. Gather context (all at once):**
- stdout/stderr from the failed run
- `operator-error.png` screenshot if it exists
- The failing step's code in `odoo_pr_to_po.mjs` (read the full function, not just the error line)
- Check episodic memory index for prior fixes matching this error pattern

**2. Diagnose:**
- Identify root cause: selector changed, auth failure, network timeout, Odoo UI change, data issue, or environment problem
- State the diagnosis in one sentence
- If episodic memory has a prior fix for this pattern, evaluate whether it applies — do not blindly repeat a fix that already failed

**3. Apply fix autonomously:**
- Write the exact code change needed
- Save a copy of the original code before editing
- Apply the fix directly — no approval needed
- Re-run once and report result

**4. If the fix works:**
- Update today's episodic file with error pattern, fix, and diff-style summary
- Append a new entry to the `## Learned Error Patterns` section in `procurement-operator.md`:
  ```
  ### EP<N> — <short title>
  - Trigger: <what error/symptom appeared>
  - Root cause: <one sentence>
  - Fix: <what was changed>
  - Confidence: HIGH | Last seen: YYYY-MM-DD
  ```
  Replace "No entries yet." if this is the first pattern.

**5. If the fix doesn't work:**
- Revert the script to the original saved copy
- Report: what was tried, why it failed, what the user should do next

---

## Episodic memory — write rules

**File path:** `C:\Users\uSeR\.claude\agent-memory\procurement-operator\YYYY-MM-DD.md`

**Rule: one file per day. Append within the same day — never create a second file for the same date.**

### Entry format (append each run as a new `## HH:MM` section):
```markdown
## HH:MM — <profile> <BU>
- Status: SUCCESS | FAILED | FAILED → FIXED
- Exported: N rows
- Appended: N rows
- Skipped (duplicates): N
- Rejected (min order): <detail or None>
- Rejected (vendor): <detail or None>
```

### If FAILED → FIXED, add:
```markdown
- Error: <short description>
- Root cause: <one sentence>
- Fix: <what changed>
```

### After writing/updating the daily file:
- If it's a **new day file** → add a row to `Memory.md` index
- If the day file already exists → update the `Notable` column in `Memory.md` if something changed (e.g., a failure occurred)

### Memory.md index row format:
```
| YYYY-MM-DD | supply PSV, medicine PSV | FAILED → selector fix |
```

---

## Boundaries
- Never re-run more than once after a fix attempt without asking again
- Minimum order rejections are **not failures** — report them in the success summary, do not escalate
- Vendor rejections are **not failures** — report them in the success summary, do not escalate
- If the issue is an Odoo server outage or network problem, say so clearly and don't attempt a code fix
