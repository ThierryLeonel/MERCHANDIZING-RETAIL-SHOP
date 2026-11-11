# Backup and recovery

## What to back up
1. **PostgreSQL database** — all business data (the ledger, stock, documents, audit trail).
2. **Attachment storage** — `STORAGE_LOCAL_DIR` (or the object-storage bucket in production).
3. **Configuration** — your `.env` / secret store (never in git).

## Database backups
Daily logical backup (keep at least 30 daily + 12 monthly copies, encrypted, off-site):
```bash
pg_dump --format=custom --no-owner --file="retail-$(date +%F).dump" "$DATABASE_URL"
```
For lower data-loss windows use managed PostgreSQL with point-in-time recovery (WAL archiving), e.g. 7–35 days PITR.

## Restore
```bash
createdb retail_restore
pg_restore --no-owner --dbname=postgresql://…/retail_restore retail-2026-11-11.dump
DATABASE_URL=postgresql://…/retail_restore pnpm db:check     # schema matches the code
DATABASE_URL=postgresql://…/retail_restore pnpm db:migrate   # apply any newer migrations
```
Then run **Accounting → Reconciliation** (or `GET /api/v1/accounting/reconciliation`) and the trial balance to confirm integrity before switching traffic.

## Restore drills
Test a restore into a scratch database at least monthly and record: backup age, restore duration, reconciliation results.

## Notes
- Journal and stock tables are append-only by trigger; do not "fix" data with manual SQL — post reversals/adjustments through the application so the audit trail stays intact.
- Restoring an older backup loses transactions after that point; reconcile tills and payment-provider statements for the gap.
