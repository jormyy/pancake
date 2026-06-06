CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.enforce_trade_lifecycle_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  v_status league_status;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('accepted'::trade_status, 'completed'::trade_status) THEN
    SELECT status
      INTO v_status
      FROM leagues
     WHERE id = NEW.league_id
     FOR SHARE;

    IF v_status IS NULL THEN
      RAISE EXCEPTION 'League not found.'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_status NOT IN ('active'::league_status, 'playoffs'::league_status) THEN
      RAISE EXCEPTION 'Trades require an active or playoff season.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_trade_lifecycle_status ON public.trades;
CREATE TRIGGER enforce_trade_lifecycle_status
  BEFORE UPDATE OF status ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION private.enforce_trade_lifecycle_status();

CREATE OR REPLACE FUNCTION private.prevent_offseason_with_accepted_trades()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'offseason'::league_status
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM 1
      FROM trades
     WHERE league_id = NEW.id
       AND status = 'accepted'::trade_status
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'Cannot move league to offseason while accepted trades are unresolved.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_offseason_with_accepted_trades ON public.leagues;
CREATE TRIGGER prevent_offseason_with_accepted_trades
  BEFORE UPDATE OF status ON public.leagues
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_offseason_with_accepted_trades();

CREATE OR REPLACE FUNCTION private.sync_snake_slot_pick_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.current_owner_id IS DISTINCT FROM OLD.current_owner_id THEN
    UPDATE snake_draft_picks
       SET member_id = NEW.current_owner_id
     WHERE draft_pick_id = NEW.id
       AND player_id IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_snake_slot_pick_owner ON public.draft_picks;
CREATE TRIGGER sync_snake_slot_pick_owner
  AFTER UPDATE OF current_owner_id ON public.draft_picks
  FOR EACH ROW
  EXECUTE FUNCTION private.sync_snake_slot_pick_owner();
