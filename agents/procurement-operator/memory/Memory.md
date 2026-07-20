# Procurement Operator — Episode Index

> RAG index. Read this first. Pull only the daily file(s) relevant to current context.
> Each row = one run. Multiple runs on the same date get multiple rows (same Date value).
> Stats pulled from the script's own [SUMMARY]/Execute Log output — not hand-typed.
> Notable column flags errors, fixes, or unusual outcomes worth recalling.
> Run ID is "—" for PO-Daily runs before 2026-07-03 (script didn't emit one yet).

## Pending Leftover PRs

> PRs rejected by PR2PO (vendor mismatch or minimum order) that have NOT yet been approved or rejected via `odoo_pr_action.mjs`. Read this table at the start of every invocation, regardless of what was asked, and report it if non-empty — before doing anything else. Rows are written automatically by the batch runner (`lib/leftover-table.mjs`) — one upsert per rejected PR, keyed by PR number (earliest First Seen wins, never overwritten). A row is removed when `odoo_pr_action.mjs` executes a real (non `--test`) approve or reject for that PR number. No automatic removal otherwise: the writer never deletes rows, so a PR fixed manually in Odoo lingers here until a human clears it (a BU with an empty export that day is indistinguishable from "resolved", so silent deletion would be unsafe).
>
> **Mode column:** `live` = surfaced by a real run (validate/generate). `test` = surfaced by a `--test` dry-run — NO PO fired and NO real action taken, but it is still a genuine leftover awaiting a human, just flagged as found during a rehearsal.

| PR Number | Profile | BU | Reason | First Seen | RUN_ID | Mode |
|-----------|---------|-----|--------|-----------|--------|------|
| 57PR26060835 | supply | PSUV | vendor mismatch — item [0000001812] expected (0000000915) TERUMO MEDICAL SUPPLY, got (0000000912) | 2026-07-01 | 20260701-1605 | live |

---

## Episode Index

| Date | Run ID | Pipeline | Status | Stats | Notable |
|------|--------|----------|--------|-------|---------|
| 2026-06-10 | — | PO-Daily PUBN | SUCCESS | Printed 0 / Split 0 / Uploaded 0 | No POs found for PUBN on 2026-06-10 |
| 2026-06-11 | — | PO-Daily PSSK 2026-03-27 | SUCCESS | Printed 1 / Split 31 / Uploaded 31 | — |
| 2026-06-14 | — | PO-Daily PSNK 2026-05-15 | SUCCESS | Printed 1 / Split 27 / Uploaded 27 | — |
| 2026-06-18 | — | PO-Daily PSV 2026-05-05 | SUCCESS | Printed 4 / Split 268 / Uploaded 453 | — |
| 2026-07-01 | 20260701-1605 | PR2PO supply PSUV | SUCCESS | Exported 9 / Appended 6 / Rejected 1 (vendor) | PR 57PR26060835 — vendor mismatch |

