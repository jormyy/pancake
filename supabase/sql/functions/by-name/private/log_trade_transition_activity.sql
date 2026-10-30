-- Canonical SQL source for private.log_trade_transition_activity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.log_trade_transition_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status::text NOT IN ('accepted','rejected','withdrawn','vetoed') THEN RETURN NEW; END IF;
  SELECT id INTO actor FROM public.league_members WHERE league_id=NEW.league_id AND user_id=auth.uid();
  PERFORM private.log_league_activity(NEW.league_id,NEW.league_season_id,'trade_'||NEW.status::text,
    'Trade '||NEW.status::text,NULL,actor,NULL,NULL,NEW.id);
  RETURN NEW;
END;
$$;
