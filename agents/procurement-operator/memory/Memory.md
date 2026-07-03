# Procurement Operator — Episode Index

> RAG index. Read this first. Pull only the daily file(s) relevant to current context.
> Each row = one run. Multiple runs on the same date get multiple rows (same Date value).
> Stats pulled from the script's own [SUMMARY]/Execute Log output — not hand-typed.
> Notable column flags errors, fixes, or unusual outcomes worth recalling.
> Run ID is "—" for PO-Daily runs before 2026-07-03 (script didn't emit one yet).

## Pending Leftover PRs

> PRs rejected by PR2PO (vendor mismatch or minimum order) that have NOT yet been approved or rejected via `odoo_pr_action.mjs`. Read this table at the start of every invocation, regardless of what was asked, and report it if non-empty — before doing anything else. A row is added when PR2PO rejects a PR; removed when `odoo_pr_action.mjs` executes a real (non `--test`) approve or reject for that PR number. If a PR is acted on outside these scripts (manually in Odoo), this table will go stale — no automatic drift detection.

| PR Number | Profile | BU | Reason | First Seen | RUN_ID |
|-----------|---------|-----|--------|-----------|--------|
| 57PR26060835 | supply | PSUV | vendor mismatch — item [0000001812] expected (0000000915) TERUMO MEDICAL SUPPLY, got (0000000912) | 2026-07-01 | 20260701-1605 |

---

## Episode Index

| Date | Run ID | Pipeline | Status | Stats | Notable |
|------|--------|----------|--------|-------|---------|
| 2026-06-10 | — | PO-Daily PUBN | SUCCESS | Printed 0 / Split 0 / Uploaded 0 | No POs found for PUBN on 2026-06-10 |
| 2026-06-11 | — | PO-Daily PSSK 2026-03-27 | SUCCESS | Printed 1 / Split 31 / Uploaded 31 | — |
| 2026-06-14 | — | PO-Daily PSNK 2026-05-15 | SUCCESS | Printed 1 / Split 27 / Uploaded 27 | — |
| 2026-06-18 | — | PO-Daily PSV 2026-05-05 | SUCCESS | Printed 4 / Split 268 / Uploaded 453 | — |
| 2026-07-01 | 20260701-1605 | PR2PO supply PSUV | SUCCESS | Exported 9 / Appended 6 / Rejected 1 (vendor) | PR 57PR26060835 — vendor mismatch |

