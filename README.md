# Procurement Operation

Automation that handles the daily procurement paperwork for all 20 business units (BUs), so a human doesn't have to click through Odoo SmartERP by hand.

It does three main jobs:

1. **PR2PO** — takes Purchase Requests (PRs) waiting in Odoo, checks them against the vendor reference sheet, records everything in the BU's Google Sheet log, and (when everything passes) converts them into Purchase Orders (POs).
2. **PO Daily** — prints the day's POs from Odoo as one big PDF, splits it into one PDF per PO, and uploads each file to the right vendor folder on Google Drive.
3. **Confirm PO** — confirms POs that are sitting unconfirmed in Odoo. Note that confirming is **not** the same as sending to the vendor; dispatch is a separate human step.

PR2PO and Confirm PO are started by a person — say **"run PR2PO"** in a Claude Code session, or run the script directly.

**PO Daily also runs on its own.** It is scheduled on GitHub Actions seven times a day, unattended, against **production**. See [Scheduling](#scheduling-po-daily-runs-itself) below — this is the part people most often don't realise.

---

## How a run works (in plain words)

**PR2PO**, step by step:

1. Opens a Chrome browser and logs into Odoo (like a person would, just faster).
2. Switches to the requested BU and opens the PR-to-PO screen.
3. Exports the list of waiting PRs.
4. Checks every PR line against the **reference sheet** (a Google Sheet listing each item's approved vendor and minimum order amount).
5. Writes the results — pass or fail, with reasons — into that BU's **log sheet** on Google Sheets, so there is always a paper trail.
6. Only if a PR passed every check *and* the run was started with the generate option: clicks **"Generate to PO"** in Odoo.

That last click is the one action that **cannot be undone**. The code treats it with extra care: if anything looks wrong earlier in the run — for example the reference sheet can't be loaded — the run still records everything in the log, but it will **refuse to generate POs**. It fails safe.

**PO Daily**, step by step:

1. Logs into Odoo and finds the target day's POs for the chosen BU. "Target day" is today unless `--date` says otherwise. Two filters decide what counts: **PO Send to Vendor is Completed or Re-send PO**, *and* **Doc Approve Status is Approved**.
2. Prints them into PDF files.
3. Cuts the big PDFs into one small PDF per PO, reading the PO number and vendor name off each page.
4. Uploads each PO's PDF to Google Drive, into `<BU order folder>\YYYY\MM.MonthName\DD\MM\YYYY\<vendor>\`.

**PO Daily has no rehearsal mode.** What makes re-running it safe instead is that every upload is content-hash checked — a PO already in Drive is skipped, not duplicated. So running the same day twice costs time, not correctness.

---

## Scheduling (PO Daily runs itself)

`.github\workflows\po-daily-batch-manual.yml` runs PO Daily on GitHub Actions with seven daily cron entries, and its `environment` input **defaults to `prod`**.

- **`30 0` UTC** — the "yesterday sweep", catching POs approved after the previous day's last pass.
- **`30 1,2,3,5,7,8` UTC** — six intraday sweeps.

Those six are **deliberately booked an hour earlier than the times we actually want**, because GitHub Actions typically fires scheduled jobs about an hour late. Booked 08:30/09:30/10:30/12:30/14:30/15:30 ICT, they land at roughly 09:30/10:30/11:30/13:30/15:30/16:30. Don't "correct" them back without also removing the assumption that a run arrives late — the rationale is written into the workflow comments. The yesterday sweep is intentionally *not* shifted, because it computes its target date from the runner's clock at execution time.

You can also trigger the workflow by hand (`workflow_dispatch`) with `bu`, `date`, `max_parallel` and `environment` inputs. Runs never overlap — a concurrency group queues them instead.

The runner has no access to your local files, so it rebuilds them from GitHub secrets: `CONFIG_JSON` (the whole `config.json`), the Google tokens, `ODOO_*` credentials, and `CF_ACCESS_*` service tokens.

### UAT vs production

Every script takes `--env uat|prod` (default `uat`; `ODOO_ENV` works too). Credentials never fall back between environments — prod uses its own `_PROD` keys.

**`requireUat()` is the strongest safety mechanism in the codebase.** It blocks PR2PO, Confirm PO and PR-action from running against production at all. Only PO Daily is cleared for prod, because it only reads and prints.

When `GITHUB_ACTIONS=true`, the code automatically switches to the `gha-` Odoo hostname. That host exists because Cloudflare blocks datacenter IPs at the normal address, so cloud runs cannot reach Odoo any other way.

---

## What's in this folder

```
Procurement Operator\
│
├── odoo_pr_to_po.mjs        ← the PR2PO job (main script)
├── run-batch.mjs            ← runs the PR2PO job for every BU, a few at a time,
│                              and writes one summary report per batch
├── po-daily-pipeline.mjs    ← the PO Daily job (one BU)
├── run-po-daily-batch.mjs   ← runs PO Daily for every BU — this is what the
│                              GitHub Actions schedule calls
├── odoo_po_confirm.mjs      ← confirms unconfirmed POs (not vendor dispatch)
├── odoo_pr_action.mjs       ← approve or cancel leftover PRs one by one
├── promote_vendor_tier2.mjs ← add a vendor to the "2nd tier" list in the reference sheet
│
├── lib\                     ← shared building blocks (used by the scripts above)
│   ├── config.mjs           ← reads config.json, checks it is complete, picks the
│   │                          environment (uat/prod) and the right Odoo host
│   ├── util.mjs             ← small helpers: logging, run IDs, reading .env,
│   │                          Cloudflare Access headers
│   ├── odoo-nav.mjs         ← how to log in and move around Odoo
│   ├── sheets-client.mjs    ← how to connect to Google Sheets
│   ├── decision-log.mjs     ← writes every approve/reject/promote to the Decision Log
│   ├── memory-sync.mjs      ← pushes the Decision Log to GitHub so both PCs stay in sync
│   ├── pr-row-actions.mjs   ← the careful code that selects PR rows and clicks
│   │                          "Generate to PO" — shared by the scripts above
│   ├── arrival-date.mjs     ← works out expected arrival dates
│   ├── episode-index.mjs    ← indexes runs for the agent's memory
│   ├── execution-log.mjs    ← per-run execution record
│   └── leftover-table.mjs   ← the leftover-PR summary table
│
├── tools\                   ← one-off and diagnostic scripts (see below)
├── .github\workflows\       ← the GitHub Actions schedule for PO Daily
│
├── config.json              ← YOUR data: BU lists, sheet IDs, folder IDs
│                              (kept out of git; a copy lives in the CONFIG_JSON secret)
├── config.json.example      ← empty template showing what config.json should contain
├── .env                     ← passwords and API keys (never in git)
├── .env.example             ← the full list of keys .env needs, with no values
│
├── agents\                  ← the agent's memory: Decision Log, Memory.md, run notes
│                              (the agent definition itself lives in ~\.claude\agents)
└── package.json             ← list of software libraries the scripts need
```

**The one-line mental model:** *data* lives in `config.json`, *plumbing* lives in `lib\`, and *decisions* live in the main scripts. If something breaks, the question "wrong ID, broken login, or wrong logic?" tells you which file to look in.

### What's in `tools\`

Not part of normal operation — reach for these when investigating or backfilling.

| Script | What it's for |
|---|---|
| `drive-day-census.mjs` | counts PO PDFs per BU per day straight from Drive, and shows which day each file was uploaded — that's how you tell an intraday sweep from the next morning's |
| `peek-drive-tree.mjs` | checks whether a given BU/date folder exists in Drive |
| `probe-folder-race.mjs` | hunts for duplicate vendor folders caused by parallel uploads |
| `backfill-po-daily.mjs` | re-runs PO Daily across a date range |
| `backfill-queue.mjs` | queues backfills across many BUs, with resume state |
| `codegen-po-filter.mjs` | helper for regenerating the Odoo filter steps |
| `odoo-page-capture.mjs` | dumps an Odoo page for selector debugging |

### Why `config.json` is special

Every ID the system needs — which Google Sheet is which BU's log, which Drive folder belongs to which BU, the Odoo address — lives in this one file. Three consequences:

- **Adding a new BU never touches code.** Add one line to each of the three lists in `config.json` and every script picks it up. Miss one list and the BU half-exists: PR2PO enumerates BUs from `buOdooPrefix`, PO Daily from `buOrderFolders`, so it can run in one pipeline and silently not exist in the other.
- **The BU roster is now *only* this file.** There used to be a `BLOCKED_BUS` list in `lib\config.mjs` that excluded a BU in code no matter what the config said; it was removed on 2026-08-04. Excluding a BU now means deleting it from `config.json` — and because that file is git-ignored and per-machine, the exclusion has to hold **in three places**: this PC, the other PC, and the `CONFIG_JSON` secret. A stale copy will happily process a BU you meant to drop.
- **It is deliberately kept out of GitHub** (listed in `.gitignore`), together with `.env`, the `.g*-token.json` files, `runs\` and `knowledge.json`. The code is on GitHub; your IDs and passwords are not. That's why a fresh computer needs those files created by hand — see below.

---

## Setting up on a new computer

1. Clone this repository from GitHub.
2. Run `npm install` (fetches the software libraries listed in `package.json`).
3. Copy `config.json.example` to `config.json` and fill in the real values (or copy `config.json` from a computer that already has it).
4. Copy `.env.example` to `.env` and fill in the values — Odoo username/password (plus the `_PROD` pair), Google API keys, `GH_TOKEN`, and the Cloudflare Access service tokens. `.env.example` lists every key with no values, so it's the authoritative checklist.
5. First run will open a browser window asking you to approve Google access; after that, tokens are remembered in files like `.gsheets-token.json` (also kept off GitHub).

## Running

The normal way is through the Claude agent ("run PR2PO", "run PO daily"). Underneath, these commands exist too. **Most take positional arguments — running them bare just prints a usage error.**

| Command | What it runs |
|---|---|
| `npm run pr2po -- supply PSV [--generate] [--test] [--headless]` | PR2PO, one BU. Profile is `supply` or `medicine` |
| `node run-batch.mjs medicine --generate --headless` | PR2PO for **every** BU, a few at a time |
| `npm run po-daily -- --bu PSV [--date YYYY-MM-DD] [--headless]` | PO Daily, one BU (defaults to PSV and today) |
| `node run-po-daily-batch.mjs [--date YYYY-MM-DD] --headless [--max-parallel=2] [--env=prod]` | PO Daily for **every** BU — what the schedule calls |
| `node odoo_po_confirm.mjs supply PSUV [--headless] [--confirm]` | Confirm POs. Dry-run unless `--confirm`; `--test` overrides `--confirm` |
| `npm run pr-action -- supply PSV PR2600123 approve [--test]` | approve/cancel leftover PRs (accepts `PR#,PR#,…` or `--file=<path>`) |
| `npm run promote-tier2 -- PSV ITEM001 V00123 Vendor Name Co Ltd` | add a vendor to the 2nd-tier list |

The two **profiles** — `supply` and `medicine` — select which Odoo login and which set of BUs a run works with. Every PR-side script takes one as its first argument.

A batch run leaves its full report in `runs\<batch-id>\` — one log per BU plus
`summary.md`, a table showing per BU: pass/fail, how many PR rows passed or were
rejected, and which POs were generated.

`--test` rehearses a **PR2PO** batch with no real Odoo changes. There is no
equivalent for PO Daily — see the note above about content-hash dedup.

## Safety rules built into the code

- **Production is blocked for anything that writes.** `requireUat()` refuses to let PR2PO, Confirm PO or PR-action run against prod. Only PO Daily is cleared for production.
- **"Generate to PO" is never retried.** Odoo shows no confirmation dialog for it, and it can't be undone — so the code clicks it at most once, and only after every check passed.
- **If the reference sheet can't be read, no POs are generated.** The run logs a warning, marks the rows as unvalidated in the log sheet, and stops before the irreversible step.
- **Re-uploading is harmless.** PO Daily hashes each PDF's contents and skips anything already in Drive, so a repeated run can't duplicate files.
- **Flaky steps retry, irreversible ones don't.** In PO Daily, printing retries 3 times and uploading 4 times (Drive answers an overloaded moment with a 503, which once cost three BUs a whole day). PR2PO retries its checkpoints but never the "Generate to PO" click.
- **Everything is logged.** Every run writes what it did, per PR, into the BU's Google Sheet log — including the runs that failed.

## Where things are recorded

- **Per-BU log sheets** (Google Sheets) — one per BU, every PR2PO run appends here.
- **Reference sheet** (Google Sheets) — the vendor + minimum-order rulebook the checks run against.
- **Drive folders** — one order folder per BU, with PO Daily's split PDFs filed underneath by year, month, day and vendor.
- **Decision Log** (`agents\procurement-operator\memory\Decision Log.md`) — every human
  approve/reject/promote, stamped with date, time, PC name and user. Pushed to GitHub
  automatically after each real decision, so both computers see the same history.
- **Batch reports** (`runs\` folder) — one folder per batch run with per-BU logs and a
  summary table. Kept on this computer only (not in GitHub). Cloud runs upload theirs
  as GitHub Actions artifacts instead.

The IDs for all of these are in `config.json`.
