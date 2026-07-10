-- Canonical SQL source for public.set_veto_window.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION set_veto_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
    NEW.accepted_at = COALESCE(NEW.accepted_at, now());
    NEW.veto_window_expires_at = COALESCE(
      NEW.veto_window_expires_at,
      NEW.accepted_at + INTERVAL '24 hours'
    );
  END IF;
  RETURN NEW;
END;
$$;
