-- Canonical SQL source for private.set_trade_child_league_id.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.set_trade_child_league_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league_id uuid;
  v_proposed_at timestamptz;
BEGIN
  SELECT league_id, proposed_at INTO v_league_id, v_proposed_at
    FROM public.trades
   WHERE id = NEW.trade_id;

  IF v_league_id IS NULL THEN
    RAISE EXCEPTION 'Trade child row references an unknown trade.';
  END IF;

  IF NEW.league_id IS NOT NULL AND NEW.league_id <> v_league_id THEN
    RAISE EXCEPTION 'Trade child league_id must match the parent trade.';
  END IF;

  NEW.league_id := v_league_id;
  IF TG_TABLE_NAME = 'trade_participants' THEN
    NEW.proposed_at := v_proposed_at;
  END IF;
  RETURN NEW;
END;
$$;
