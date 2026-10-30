\set ON_ERROR_STOP on
\set port `printf %s "$PANCAKE_TEST_DB_PORT"`
\set url `printf %s "$SUPABASE_DB_URL"`
\set conn postgresql://authenticator:postgres@127.0.0.1: :port /postgres
\connect :conn
SET ROLE service_role;
BEGIN;
DO $$
BEGIN
  BEGIN
    CREATE TEMP TABLE notification_guard_probe(x integer);
    DELETE FROM notification_guard_probe;
    RAISE EXCEPTION 'BUG: the API session guard is not loaded';
  EXCEPTION WHEN SQLSTATE '21000' THEN NULL;
  END;
END;
$$;
ROLLBACK;
RESET ROLE;
\connect :url
BEGIN;
UPDATE private.notification_scan_state SET scan_at=NULL,after_member_id=NULL,available_at=now()-interval '1 minute' WHERE id;
INSERT INTO private.notification_scan_dirty(id) VALUES(true) ON CONFLICT DO NOTHING;
COMMIT;
\connect :conn
SET ROLE service_role;
SELECT public.run_scheduler_chunk('notifications',false,now());
\connect :url
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM private.notification_scan_dirty)
    OR NOT EXISTS(SELECT 1 FROM private.notification_scan_state WHERE id AND scan_at IS NOT NULL) THEN
    RAISE EXCEPTION 'BUG: notification scan cannot start through the API session';
  END IF;
END;
$$;
UPDATE private.notification_scan_state SET scan_at=NULL,after_member_id=NULL WHERE id;
INSERT INTO private.notification_scan_dirty(id) VALUES(true) ON CONFLICT DO NOTHING;
