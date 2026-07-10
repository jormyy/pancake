SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE OR REPLACE FUNCTION private.prevent_conflicting_or_inactive_trade_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'accepted'::trade_status AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM private.assert_trade_assets_acceptance_ready(
      NEW.id,
      NEW.league_id,
      NEW.league_season_id
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.prevent_conflicting_or_inactive_trade_accept()
  FROM PUBLIC, anon, authenticated, service_role;

RESET statement_timeout;
RESET lock_timeout;
