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

REVOKE ALL ON FUNCTION private.guard_dynasty_rank_source() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS players_dynasty_rank_owner ON public.players;
CREATE TRIGGER players_dynasty_rank_owner
  BEFORE INSERT OR UPDATE OF dynasty_rank, dynasty_rank_source ON public.players
  FOR EACH ROW EXECUTE FUNCTION private.guard_dynasty_rank_source();
