CREATE OR REPLACE FUNCTION public.rebuild_nba_calendar_atomic(p_season_year int)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_games jsonb;
BEGIN
  PERFORM private.lock_nba_source(p_season_year);
  SELECT COALESCE(jsonb_agg(to_jsonb(game)),'[]'::jsonb) INTO v_games FROM nba_games game
    WHERE season_year=p_season_year AND (nba_game_id LIKE '002%' OR nba_game_id !~ '^00[0-9]');
  IF jsonb_array_length(v_games)=0 THEN RETURN 0; END IF;
  PERFORM public.assert_nba_game_imports(v_games);
  IF EXISTS(SELECT 1 FROM season_weeks WHERE season_year=p_season_year) THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(v_games) AS game(game_date date)
      WHERE (SELECT count(*) FROM season_weeks week WHERE week.season_year=p_season_year
        AND game.game_date BETWEEN week.week_start AND week.week_end)<>1
    ) THEN
      RAISE EXCEPTION 'Calendar resolution required: load a complete schedule covering every retained game before retrying enumeration. Existing calendar is preserved.' USING ERRCODE='55000';
    END IF;
    SELECT jsonb_agg(game.value||jsonb_build_object('week_number',week.week_number)) INTO v_games
      FROM jsonb_array_elements(v_games) game(value) JOIN season_weeks week ON week.season_year=p_season_year
        AND (game.value->>'game_date')::date BETWEEN week.week_start AND week.week_end;
    -- A uniquely recorded range is authoritative for provisional enum numbers.
    UPDATE nba_games game SET week_number=(row->>'week_number')::int
      FROM jsonb_array_elements(v_games) row WHERE game.id=(row->>'id')::uuid
        AND game.week_number IS DISTINCT FROM (row->>'week_number')::int;
    UPDATE player_game_stats stat SET week_number=game.week_number FROM nba_games game
      WHERE stat.game_id=game.id AND game.season_year=p_season_year AND stat.week_number IS DISTINCT FROM game.week_number;
    RETURN 0;
  END IF;
  RAISE EXCEPTION 'Calendar resolution required: enumeration cannot establish a complete calendar. Load a verified complete season schedule before retrying.' USING ERRCODE='55000';
END;
$$;
