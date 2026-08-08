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
| 52PR26070842 | medicine | PSV | wrong vendor on [0000000802]: got "(0000000765,0000000765) บริษัท โรงพยาบาลปากน้ำโพ จำกัด", expected "(0000000276) บริษัท แอตแลนติค ฟาร์มาซูติคอล จำกัด" | 2026-07-20 | 20260720-1303 | test |
| 59PR26070221 | medicine | PLPN1 | wrong vendor on [0000007590]: got "(0000000286) บริษัท บี.เอ็ล.ฮั้ว จำกัด", expected "(0000000274) บริษัท เอ.เอ็น.บี.ลาบอราตอรี่ จำกัด" | 2026-07-20 | 20260720-1304 | test |
| 67PR26070222 | medicine | PSNK | wrong vendor on [0000000272]: got "(0000000365) บริษัท ดีซีเอช ออริกา (ประเทศไทย) จำกัด", expected "(0000010174) ห้างหุ้นส่วนจำกัด ยูฟาร์มา" | 2026-07-20 | 20260720-1305 | test |
| 67PR26070225 | medicine | PSNK | wrong vendor on [0000000018]: got "(0000005508) บริษัท เอเบิ้ล เมดิคอล จำกัด", expected "(0000009542) บริษัท พริ้นซิเพิล เฮลท์แคร์ - มุกดาหาร จำกัด" | 2026-07-20 | 20260720-1305 | test |
| 69PR26070205 | medicine | PMDH | wrong vendor on [0000000581]: got "(0000005508) บริษัท เอเบิ้ล เมดิคอล จำกัด", expected "(0000007413) บริษัท พริ้นซิเพิล เฮลท์แคร์ - สกลนคร จำกัด" | 2026-07-20 | 20260720-1305 | test |
| 69PR26070206 | medicine | PMDH | wrong vendor on [0000007739]: got "(0000010223) บริษัท อีสานโอสถ จำกัด", expected "(0000002618) บริษัท พาตาร์แลป (2517) จำกัด" | 2026-07-20 | 20260720-1305 | test |

---

## Episode Index

| Date | Run ID | Pipeline | Status | Stats | Notable |
|------|--------|----------|--------|-------|---------|
| 2026-06-10 | — | PO-Daily PUBN | SUCCESS | Printed 0 / Split 0 / Uploaded 0 | No POs found for PUBN on 2026-06-10 |
| 2026-06-11 | — | PO-Daily PSSK 2026-03-27 | SUCCESS | Printed 1 / Split 31 / Uploaded 31 | — |
| 2026-06-14 | — | PO-Daily PSNK 2026-05-15 | SUCCESS | Printed 1 / Split 27 / Uploaded 27 | — |
| 2026-06-18 | — | PO-Daily PSV 2026-05-05 | SUCCESS | Printed 4 / Split 268 / Uploaded 453 | — |
| 2026-07-01 | 20260701-1605 | PR2PO supply PSUV | SUCCESS | Exported 9 / Appended 6 / Rejected 1 (vendor) | PR 57PR26060835 — vendor mismatch |
| 2026-07-20 | 20260720-0657 | PR2PO medicine batch | SUCCESS | 18 BU · 4 active · 0 pass · 6 reject · 0 PO | --test rehearsal (no PO) |
| 2026-07-20 | 20260720-0744 | PO-Daily batch 2026-05-05 | SUCCESS | 1 BU · 1 with POs · 4 printed · 0 uploaded · 268 dup-skip | print + upload |
| 2026-07-24 | 20260724-1118 | PO-Daily PSNK 2026-07-17 | SUCCESS | Printed 1 / Split 30 / Uploaded 30 / Skipped 0 | PRINT stage retried 2× (waitForResponse closed/timeout), succeeded on attempt 3/3 |
| 2026-07-27 | 20260727-1406 | PO-Daily batch 2026-05-05 | SUCCESS | 1 BU · 1 with POs · 4 printed · 267 uploaded · 0 dup-skip | print + upload |
| 2026-07-29 | — | PO-Daily BACKFILL 2026-01-01→2026-07-15 | SUCCESS | 18 BU · 3,528 date-runs · 59,826 uploaded · 0 failed | One row for the whole historical backfill, not one per date — `tools/backfill-queue.mjs` calls the pipeline directly and bypasses the batch runner's memory sync, which would otherwise have meant 3,528 commits. 4 transient failures (one Drive 502, three unexplained child exits) all cleared on the retry pass. Folder depth is now year/NN.Month/DD/MM/YYYY/vendor |
| 2026-08-03 | 20260803-1036 | PO-Daily batch 3 Aug 2026 | FAILED | 1 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 1 BU failed |
| 2026-08-03 | 20260803-1317 | PO-Daily batch 2026-08-03 | SUCCESS | 18 BU · 17 with POs · 18 printed · 418 uploaded · 0 dup-skip | 1 BU had no POs |
| 2026-08-03 | 20260803-0645 | PO-Daily batch 2026-08-03 | FAILED | 1 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 1 BU failed |
| 2026-08-03 | 20260803-0648 | PO-Daily batch 2026-08-03 | FAILED | 1 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 1 BU failed |
| 2026-08-03 | 20260803-0706 | PO-Daily batch 2026-08-03 | SUCCESS | 1 BU · 1 with POs · 2 printed · 10 uploaded · 140 dup-skip | print + upload |
| 2026-08-03 | 20260803-0720 | PO-Daily batch 2026-08-03 | SUCCESS | 1 BU · 1 with POs · 2 printed · 1 uploaded · 1 replaced · 149 dup-skip | 1 PO(s) re-issued and replaced |
| 2026-08-03 | 20260803-0743 | PO-Daily batch 3 Aug 2026 | SUCCESS | 1 BU · 1 with POs · 2 printed · 4 uploaded · 150 dup-skip | print + upload |
| 2026-08-03 | 20260803-1451 | PO-Daily batch 2026-08-03 | PARTIAL | 18 BU · 18 with POs · 20 printed · 147 uploaded · 383 dup-skip | 3 BU failed |
| 2026-08-03 | 20260803-1627 | PO-Daily batch 2026-08-03 | SUCCESS | 1 BU · 1 with POs · 1 printed · 15 uploaded · 46 dup-skip | print + upload |
| 2026-08-03 | 20260803-1628 | PO-Daily batch 2026-08-03 | SUCCESS | 1 BU · 1 with POs · 1 printed · 38 uploaded · 17 dup-skip | print + upload |
| 2026-08-03 | 20260803-1630 | PO-Daily batch 2026-08-03 | SUCCESS | 1 BU · 1 with POs · 1 printed · 25 uploaded · 12 dup-skip | print + upload |
| 2026-08-03 | 20260803-1652 | PO-Daily batch 2026-08-03 | SUCCESS | 1 BU · 1 with POs · 1 printed · 0 uploaded · 10 dup-skip | print + upload |
| 2026-08-03 | 20260803-1154 | PO-Daily batch 3 Aug 2026 | SUCCESS | 18 BU · 18 with POs · 21 printed · 180 uploaded · 2 replaced · 679 dup-skip | 2 PO(s) re-issued and replaced |
| 2026-08-04 | 20260804-0350 | PO-Daily batch 2026-08-03 | SUCCESS | 18 BU · 18 with POs · 21 printed · 46 uploaded · 2 replaced · 858 dup-skip | 2 PO(s) re-issued and replaced |
| 2026-08-04 | 20260804-0529 | PO-Daily batch 4 Aug 2026 | SUCCESS | 18 BU · 1 with POs · 1 printed · 2 uploaded · 0 dup-skip | 17 BU had no POs |
| 2026-08-04 | 20260804-0731 | PO-Daily batch 4 Aug 2026 | SUCCESS | 18 BU · 3 with POs · 3 printed · 10 uploaded · 2 dup-skip | 15 BU had no POs |
| 2026-08-04 | 20260804-1046 | PO-Daily batch 4 Aug 2026 | SUCCESS | 20 BU · 8 with POs · 8 printed · 43 uploaded · 12 dup-skip | 12 BU had no POs |
| 2026-08-04 | 20260804-1106 | PO-Daily batch 4 Aug 2026 | SUCCESS | 20 BU · 8 with POs · 8 printed · 0 uploaded · 55 dup-skip | 12 BU had no POs |
| 2026-08-04 | 20260804-1141 | PO-Daily batch 4 Aug 2026 | PARTIAL | 20 BU · 5 with POs · 5 printed · 0 uploaded · 40 dup-skip | 4 BU failed |
| 2026-08-05 | 20260805-0230 | PO-Daily batch 5 Aug 2026 | SUCCESS | 20 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 20 BU had no POs |
| 2026-08-05 | 20260805-0238 | PO-Daily batch 2026-08-04 | SUCCESS | 20 BU · 8 with POs · 8 printed · 14 uploaded · 55 dup-skip | 12 BU had no POs |
| 2026-08-05 | 20260805-0344 | PO-Daily batch 2026-08-04 | SUCCESS | 20 BU · 9 with POs · 9 printed · 4 uploaded · 69 dup-skip | 11 BU had no POs |
| 2026-08-05 | 20260805-0529 | PO-Daily batch 5 Aug 2026 | SUCCESS | 20 BU · 10 with POs · 11 printed · 345 uploaded · 0 dup-skip | 10 BU had no POs |
| 2026-08-05 | 20260805-0609 | PO-Daily batch 5 Aug 2026 | SUCCESS | 20 BU · 12 with POs · 13 printed · 18 uploaded · 395 dup-skip | 8 BU had no POs |
| 2026-08-05 | 20260805-0801 | PO-Daily batch 5 Aug 2026 | SUCCESS | 20 BU · 17 with POs · 19 printed · 338 uploaded · 413 dup-skip | 3 BU had no POs |
| 2026-08-05 | 20260805-1005 | PO-Daily batch 5 Aug 2026 | SUCCESS | 20 BU · 18 with POs · 22 printed · 137 uploaded · 2 replaced · 748 dup-skip | 2 PO(s) re-issued and replaced |
| 2026-08-05 | 20260805-1101 | PO-Daily batch 5 Aug 2026 | SUCCESS | 20 BU · 18 with POs · 22 printed · 12 uploaded · 886 dup-skip | 2 BU had no POs |
| 2026-08-06 | 20260806-0322 | PO-Daily batch 6 Aug 2026 | SUCCESS | 20 BU · 1 with POs · 1 printed · 3 uploaded · 0 dup-skip | 19 BU had no POs |
| 2026-08-06 | 20260806-0349 | PO-Daily batch 2026-08-05 | SUCCESS | 20 BU · 18 with POs · 22 printed · 61 uploaded · 896 dup-skip | 2 BU had no POs |
| 2026-08-06 | 20260806-0403 | PO-Daily batch 2026-08-05 | SUCCESS | 20 BU · 18 with POs · 22 printed · 0 uploaded · 957 dup-skip | 2 BU had no POs |
| 2026-08-06 | 20260806-0446 | PO-Daily batch 6 Aug 2026 | SUCCESS | 20 BU · 3 with POs · 3 printed · 3 uploaded · 3 dup-skip | 17 BU had no POs |
| 2026-08-06 | 20260806-0531 | PO-Daily batch 6 Aug 2026 | SUCCESS | 20 BU · 3 with POs · 3 printed · 1 uploaded · 6 dup-skip | 17 BU had no POs |
| 2026-08-06 | 20260806-0904 | PO-Daily batch 6 Aug 2026 | SUCCESS | 20 BU · 5 with POs · 5 printed · 9 uploaded · 7 dup-skip | 15 BU had no POs |
| 2026-08-06 | 20260806-1008 | PO-Daily batch 6 Aug 2026 | SUCCESS | 20 BU · 6 with POs · 6 printed · 5 uploaded · 16 dup-skip | 14 BU had no POs |
| 2026-08-06 | 20260806-1103 | PO-Daily batch 6 Aug 2026 | SUCCESS | 20 BU · 6 with POs · 6 printed · 0 uploaded · 21 dup-skip | 14 BU had no POs |
| 2026-08-07 | 20260807-0224 | PO-Daily batch 7 Aug 2026 | SUCCESS | 20 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 20 BU had no POs |
| 2026-08-07 | 20260807-0232 | PO-Daily batch 2026-08-06 | SUCCESS | 20 BU · 8 with POs · 8 printed · 16 uploaded · 21 dup-skip | 12 BU had no POs |
| 2026-08-07 | 20260807-0329 | PO-Daily batch 2026-08-06 | SUCCESS | 20 BU · 8 with POs · 8 printed · 4 uploaded · 37 dup-skip | 12 BU had no POs |
| 2026-08-07 | 20260807-0413 | PO-Daily batch 7 Aug 2026 | SUCCESS | 20 BU · 12 with POs · 12 printed · 193 uploaded · 0 dup-skip | 8 BU had no POs |
| 2026-08-07 | 20260807-0436 | PO-Daily batch 7 Aug 2026 | SUCCESS | 20 BU · 13 with POs · 13 printed · 58 uploaded · 193 dup-skip | 7 BU had no POs |
| 2026-08-07 | 20260807-0510 | PO-Daily batch 7 Aug 2026 | SUCCESS | 20 BU · 13 with POs · 14 printed · 51 uploaded · 251 dup-skip | 7 BU had no POs |
| 2026-08-07 | 20260807-0644 | PO-Daily batch 7 Aug 2026 | SUCCESS | 20 BU · 17 with POs · 18 printed · 123 uploaded · 302 dup-skip | 3 BU had no POs |
| 2026-08-07 | 20260807-0834 | PO-Daily batch 7 Aug 2026 | SUCCESS | 20 BU · 17 with POs · 19 printed · 226 uploaded · 425 dup-skip | 3 BU had no POs |
| 2026-08-07 | 20260807-0934 | PO-Daily batch 7 Aug 2026 | SUCCESS | 20 BU · 18 with POs · 21 printed · 94 uploaded · 1 replaced · 650 dup-skip | 1 PO(s) re-issued and replaced |
| 2026-08-08 | 20260808-0229 | PO-Daily batch 2026-08-07 | SUCCESS | 20 BU · 18 with POs · 22 printed · 55 uploaded · 1 replaced · 744 dup-skip | 1 PO(s) re-issued and replaced |
| 2026-08-08 | 20260808-0311 | PO-Daily batch 8 Aug 2026 | SUCCESS | 20 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 20 BU had no POs |
| 2026-08-08 | 20260808-0350 | PO-Daily batch 8 Aug 2026 | SUCCESS | 20 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 20 BU had no POs |
| 2026-08-08 | 20260808-0433 | PO-Daily batch 8 Aug 2026 | SUCCESS | 20 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 20 BU had no POs |
| 2026-08-08 | 20260808-0605 | PO-Daily batch 8 Aug 2026 | SUCCESS | 20 BU · 0 with POs · 0 printed · 0 uploaded · 0 dup-skip | 20 BU had no POs |

