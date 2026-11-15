-- Audit log retention: entries stay append-only, except that entries OLDER THAN
-- 6 MONTHS may be deleted by the application's purge action (which sets the
-- transaction-local flag app.audit_purge). Updates remain impossible, and recent
-- entries can never be deleted, whatever the flag.
CREATE OR REPLACE FUNCTION fn_audit_events_retention() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_purge', true) = 'on'
     AND OLD.created_at < now() - interval '6 months' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (only entries older than 6 months can be purged)';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_append_only ON audit_events;
CREATE TRIGGER trg_audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fn_audit_events_retention();

INSERT INTO "permissions" ("id", "code", "module", "description", "sensitive") VALUES
  (gen_random_uuid(), 'admin.audit_purge', 'admin', 'Delete audit log entries older than 6 months', true)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."code" = 'admin.audit_purge'
WHERE r."code" = 'OWNER'
ON CONFLICT DO NOTHING;
