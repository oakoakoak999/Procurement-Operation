# Procurement Operation

Automation that handles the daily procurement paperwork for all 19 business units (BUs), so a human doesn't have to click through Odoo SmartERP by hand.

It does two main jobs:

1. **PR2PO** — takes Purchase Requests (PRs) waiting in Odoo, checks them against the vendor reference sheet, records everything in the BU's Google Sheet log, and (when everything passes) converts them into Purchase Orders (POs).
2. **PO Daily** — prints the day's POs from Odoo as one big PDF, splits it into one PDF per PO, and uploads each file to the right vendor folder on Google Drive.

Both are run by asking the Claude procurement agent — say **"run PR2PO"** or **"run PO daily"** in a Claude Code session. They are not scheduled; a person always starts them.

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

1. Logs into Odoo, finds today's POs for the chosen BU.
2. Prints them into PDF files.
3. Cuts the big PDFs into one small PDF per PO, reading the PO number and vendor name off each page.
4. Uploads each PO's PDF into that BU's folder on Google Drive, organised by vendor.

---

## What's in this folder

```
Claude Code\
│
├── odoo_pr_to_po.mjs        ← the PR2PO job (main script)
├── run-batch.mjs            ← runs the PR2PO job for every BU, a few at a time,
│                              and writes one summary report per batch
├── po-daily-pipeline.mjs    ← the PO Daily job (main script)
├── odoo_pr_action.mjs       ← approve or cancel leftover PRs one by one
├── promote_vendor_tier2.mjs ← add a vendor to the "2nd tier" list in the reference sheet
│
├── lib\                     ← shared building blocks (used by the scripts above)
│   ├── config.mjs           ← reads config.json and checks it is complete
│   ├── util.mjs             ← small helpers: logging, run IDs, reading .env
│   ├── odoo-nav.mjs         ← how to log in and move around Odoo
│   ├── sheets-client.mjs    ← how to connect to Google Sheets
│   ├── decision-log.mjs     ← writes every approve/reject/promote to the Decision Log
│   ├── memory-sync.mjs      ← pushes the Decision Log to GitHub so both PCs stay in sync
│   └── pr-row-actions.mjs   ← the careful code that selects PR rows and clicks
│                              "Generate to PO" — shared by the scripts above
│
├── config.json              ← YOUR data: BU lists, sheet IDs, folder IDs
│                              (stays on this computer only — never uploaded)
├── config.json.example      ← empty template showing what config.json should contain
├── .env                     ← passwords and API keys (also never uploaded)
│
├── agents\                  ← instructions for the Claude agent that runs the pipelines
└── package.json             ← list of software libraries the scripts need
```

**The one-line mental model:** *data* lives in `config.json`, *plumbing* lives in `lib\`, and *decisions* live in the main scripts. If something breaks, the question "wrong ID, broken login, or wrong logic?" tells you which file to look in.

### Why `config.json` is special

Every ID the system needs — which Google Sheet is which BU's log, which Drive folder belongs to which BU, the Odoo address — lives in this one file. Two consequences:

- **Adding a new BU never touches code.** Add one line to each list in `config.json` and every script picks it up.
- **It is deliberately kept out of GitHub** (listed in `.gitignore`), together with `.env`. The code is on GitHub; your IDs and passwords are not. That's why a fresh computer needs those two files created by hand — see below.

---

## Setting up on a new computer

1. Clone this repository from GitHub.
2. Run `npm install` (fetches the software libraries listed in `package.json`).
3. Copy `config.json.example` to `config.json` and fill in the real values (or copy `config.json` from a computer that already has it).
4. Create `.env` with the Odoo username/password and Google API keys (copy from an existing machine — it is never in GitHub).
5. First run will open a browser window asking you to approve Google access; after that, tokens are remembered in files like `.gsheets-token.json` (also kept off GitHub).

## Running

The normal way is through the Claude agent ("run PR2PO", "run PO daily"). Underneath, these commands exist too:

| Command | What it runs |
|---|---|
| `npm run pr2po` | PR2PO pipeline |
| `npm run po-daily` | PO Daily pipeline |
| `npm run pr-action` | approve/cancel a leftover PR |
| `npm run promote-tier2` | add a vendor to the 2nd-tier list |

## Safety rules built into the code

- **"Generate to PO" is never retried.** Odoo shows no confirmation dialog for it, and it can't be undone — so the code clicks it at most once, and only after every check passed.
- **If the reference sheet can't be read, no POs are generated.** The run logs a warning, marks the rows as unvalidated in the log sheet, and stops before the irreversible step.
- **Everything is logged.** Every run writes what it did, per PR, into the BU's Google Sheet log — including the runs that failed.

## Where things are recorded

- **Per-BU log sheets** (Google Sheets) — one per BU, every PR2PO run appends here.
- **Reference sheet** (Google Sheets) — the vendor + minimum-order rulebook the checks run against.
- **Drive folders** — one per BU, where PO Daily uploads the split PDFs.

The IDs for all of these are in `config.json`.
