-- Canonical SQL source for private.guard_dynasty_rank_source.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_dynasty_rank_source()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.dynasty_rank_source = 'hashtagbasketball.com'
    OR (NEW.dynasty_rank IS NULL AND NEW.dynasty_rank_source IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'players.dynasty_rank is owned by the Hashtag five-year points sync; write trade values to dynasty_rankings with source onenumberhoops.com'
    USING ERRCODE = 'check_violation',
          DETAIL = format('player %s got dynasty_rank %s from source %s', NEW.id, NEW.dynasty_rank, NEW.dynasty_rank_source);
END;
$$;
