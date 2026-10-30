-- Canonical SQL source for public.assert_nba_game_imports.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.assert_nba_game_imports(p_games jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game record;
BEGIN
  IF jsonb_typeof(p_games) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Game imports must be an array.' USING ERRCODE='22023'; END IF;
  FOR v_game IN SELECT DISTINCT season_year FROM jsonb_to_recordset(p_games) AS g(season_year int) ORDER BY season_year LOOP
    PERFORM private.lock_nba_source(v_game.season_year);
  END LOOP;
  FOR v_game IN SELECT * FROM jsonb_to_recordset(p_games) AS g(nba_game_id text,season_year int,game_date date,home_team text,away_team text) LOOP
    IF v_game.nba_game_id IS NULL OR v_game.game_date IS NULL OR NULLIF(btrim(v_game.home_team),'') IS NULL OR NULLIF(btrim(v_game.away_team),'') IS NULL THEN
      RAISE EXCEPTION 'Game identity is incomplete.' USING ERRCODE='22023';
    END IF;
    PERFORM private.assert_nba_game_candidate(v_game.nba_game_id,v_game.season_year,v_game.game_date,v_game.home_team,v_game.away_team);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_games) AS a(nba_game_id text,season_year int,game_date date,home_team text,away_team text)
    JOIN jsonb_to_recordset(p_games) AS b(nba_game_id text,season_year int,game_date date,home_team text,away_team text)
      USING(season_year,game_date)
    WHERE a.nba_game_id<>b.nba_game_id AND upper(btrim(a.home_team))=upper(btrim(b.home_team))
      AND upper(btrim(a.away_team))=upper(btrim(b.away_team))
      AND private.nba_game_provider(a.nba_game_id)<>private.nba_game_provider(b.nba_game_id)
  ) THEN RAISE EXCEPTION 'Import contains unresolved game identities. Verify the provider relationship.' USING ERRCODE='55000'; END IF;
END;
$$;
