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

