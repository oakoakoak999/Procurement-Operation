# Decision Log

Append-only audit trail of every real (non --test) decision executed through
the scripts. Rows are written automatically — do not edit or remove them.
APPROVE / REJECT come from odoo_pr_action.mjs (one row per PR);
TIER2-PROMOTE comes from promote_vendor_tier2.mjs (reference-sheet whitelist
write that makes the vendor auto-pass in future runs).

| Date | Time | PC | User | Event | Profile | BU | Detail |
|------|------|----|------|-------|---------|----|--------|
