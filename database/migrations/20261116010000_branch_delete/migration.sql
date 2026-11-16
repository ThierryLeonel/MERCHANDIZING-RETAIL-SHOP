-- Deleting an unused branch. Audit entries stay append-only, with one narrow
-- exception: while the application deletes a branch (transaction-local flag
-- app.branch_delete = the branch id) an entry's branch_id may be cleared for THAT
-- branch only, and nothing else in the row may change. The entry's summary text
-- still names the branch, and the deletion itself is audited.
CREATE OR REPLACE FUNCTION fn_audit_events_retention() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_purge', true) = 'on'
     AND OLD.created_at < now() - interval '6 months' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.branch_id IS NOT NULL
     AND NEW.branch_id IS NULL
     AND current_setting('app.branch_delete', true) = OLD.branch_id::text
     AND (to_jsonb(NEW) - 'branch_id') = (to_jsonb(OLD) - 'branch_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (only entries older than 6 months can be purged)';
END $$ LANGUAGE plpgsql;
