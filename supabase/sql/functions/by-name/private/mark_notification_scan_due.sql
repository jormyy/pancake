-- Canonical SQL source for private.mark_notification_scan_due.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.mark_notification_scan_due()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  INSERT INTO private.notification_scan_dirty(id) VALUES(true) ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
