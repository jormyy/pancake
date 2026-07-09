-- Preserve RPC-provided veto deadlines while retaining the legacy default.

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
