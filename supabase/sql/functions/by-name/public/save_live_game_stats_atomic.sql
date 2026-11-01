-- Canonical SQL source for public.save_live_game_stats_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.save_live_game_stats_atomic(
  p_game_id uuid, p_provider_game_id text, p_stats jsonb, p_elapsed_seconds numeric
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year integer; v_changed integer := 0;
BEGIN
  IF p_elapsed_seconds IS NULL OR p_elapsed_seconds<0 OR p_elapsed_seconds='NaN'::numeric THEN
    RAISE EXCEPTION 'Live game progress is required.' USING ERRCODE='22023';
  END IF;
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  IF current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text
    AND EXISTS(SELECT 1 FROM private.live_feed_state WHERE game_id=p_game_id AND stats_source='espn')
    AND v_game.live_stats_elapsed_seconds>=p_elapsed_seconds THEN RETURN 0; END IF;
  IF v_game.status='Final' OR v_game.live_stats_elapsed_seconds>p_elapsed_seconds THEN RETURN 0; END IF;
  IF NOT EXISTS(SELECT 1 FROM private.live_game_identity_checks WHERE game_id=p_game_id) THEN
    PERFORM public.assert_nba_game_unambiguous(p_game_id);
  END IF;
  IF EXISTS (SELECT 1 FROM private.game_stat_revisions WHERE game_id=p_game_id)
    AND current_setting('app.verified_stats_game',true) IS DISTINCT FROM p_game_id::text THEN
    RAISE EXCEPTION 'A versioned snapshot is required for verified game data.' USING ERRCODE='PT409';
  END IF;
  IF v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game provider identity changed. Fetch the game again.' USING ERRCODE = 'PT409';
  END IF;
  IF jsonb_typeof(p_stats) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A complete parsed box score is required.' USING ERRCODE = '22023';
  END IF;
  IF v_game.status = 'Final' THEN
    RAISE EXCEPTION 'Final game box score is not final.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_stats)>0 THEN
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS row
    WHERE row.player_id IS NULL OR row.game_id IS DISTINCT FROM p_game_id
       OR row.did_not_play IS NULL
  ) OR (SELECT count(DISTINCT (row->>'player_id')::uuid) FROM jsonb_array_elements(p_stats) AS row) <> jsonb_array_length(p_stats) THEN
    RAISE EXCEPTION 'Box score rows do not match the current game or contain duplicate players.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.player_game_stats AS stored (
    player_id, game_id, is_home, season_year, week_number, minutes_played, points, rebounds, offensive_rebounds, defensive_rebounds, assists, steals, blocks, turnovers, personal_fouls, field_goals_made, field_goals_attempted, three_pointers_made, three_pointers_attempted, free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double, did_not_play, updated_at
  )
  SELECT incoming.player_id, v_game.id, incoming.is_home, v_game.season_year, v_game.week_number, incoming.minutes_played, incoming.points, incoming.rebounds, incoming.offensive_rebounds, incoming.defensive_rebounds, incoming.assists, incoming.steals, incoming.blocks, incoming.turnovers, incoming.personal_fouls, incoming.field_goals_made, incoming.field_goals_attempted, incoming.three_pointers_made, incoming.three_pointers_attempted, incoming.free_throws_made, incoming.free_throws_attempted, incoming.plus_minus, incoming.double_double, incoming.triple_double, incoming.did_not_play, clock_timestamp()
  FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS incoming
  LEFT JOIN public.player_game_stats previous ON previous.player_id=incoming.player_id AND previous.game_id=v_game.id
  WHERE previous.player_id IS NULL OR ROW(previous.player_id, previous.game_id, previous.is_home, previous.season_year, previous.week_number, previous.minutes_played, previous.points, previous.rebounds, previous.offensive_rebounds, previous.defensive_rebounds, previous.assists, previous.steals, previous.blocks, previous.turnovers, previous.personal_fouls, previous.field_goals_made, previous.field_goals_attempted, previous.three_pointers_made, previous.three_pointers_attempted, previous.free_throws_made, previous.free_throws_attempted, previous.plus_minus, previous.double_double, previous.triple_double, previous.did_not_play)
    IS DISTINCT FROM ROW(incoming.player_id, v_game.id, COALESCE(incoming.is_home, previous.is_home), v_game.season_year, v_game.week_number, incoming.minutes_played, incoming.points, incoming.rebounds, incoming.offensive_rebounds, incoming.defensive_rebounds, incoming.assists, incoming.steals, incoming.blocks, incoming.turnovers, incoming.personal_fouls, incoming.field_goals_made, incoming.field_goals_attempted, incoming.three_pointers_made, incoming.three_pointers_attempted, incoming.free_throws_made, incoming.free_throws_attempted, incoming.plus_minus, incoming.double_double, incoming.triple_double, incoming.did_not_play)
  ON CONFLICT (player_id, game_id) DO UPDATE SET
    is_home = COALESCE(EXCLUDED.is_home, stored.is_home),
    season_year = EXCLUDED.season_year,
    week_number = EXCLUDED.week_number,
    minutes_played = EXCLUDED.minutes_played,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    offensive_rebounds = EXCLUDED.offensive_rebounds,
    defensive_rebounds = EXCLUDED.defensive_rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    turnovers = EXCLUDED.turnovers,
    personal_fouls = EXCLUDED.personal_fouls,
    field_goals_made = EXCLUDED.field_goals_made,
    field_goals_attempted = EXCLUDED.field_goals_attempted,
    three_pointers_made = EXCLUDED.three_pointers_made,
    three_pointers_attempted = EXCLUDED.three_pointers_attempted,
    free_throws_made = EXCLUDED.free_throws_made,
    free_throws_attempted = EXCLUDED.free_throws_attempted,
    plus_minus = EXCLUDED.plus_minus,
    double_double = EXCLUDED.double_double,
    triple_double = EXCLUDED.triple_double,
    did_not_play = EXCLUDED.did_not_play,
    updated_at = EXCLUDED.updated_at
  WHERE ROW(stored.player_id, stored.game_id, stored.is_home, stored.season_year, stored.week_number, stored.minutes_played, stored.points, stored.rebounds, stored.offensive_rebounds, stored.defensive_rebounds, stored.assists, stored.steals, stored.blocks, stored.turnovers, stored.personal_fouls, stored.field_goals_made, stored.field_goals_attempted, stored.three_pointers_made, stored.three_pointers_attempted, stored.free_throws_made, stored.free_throws_attempted, stored.plus_minus, stored.double_double, stored.triple_double, stored.did_not_play)
    IS DISTINCT FROM ROW(EXCLUDED.player_id, EXCLUDED.game_id, COALESCE(EXCLUDED.is_home, stored.is_home), EXCLUDED.season_year, EXCLUDED.week_number, EXCLUDED.minutes_played, EXCLUDED.points, EXCLUDED.rebounds, EXCLUDED.offensive_rebounds, EXCLUDED.defensive_rebounds, EXCLUDED.assists, EXCLUDED.steals, EXCLUDED.blocks, EXCLUDED.turnovers, EXCLUDED.personal_fouls, EXCLUDED.field_goals_made, EXCLUDED.field_goals_attempted, EXCLUDED.three_pointers_made, EXCLUDED.three_pointers_attempted, EXCLUDED.free_throws_made, EXCLUDED.free_throws_attempted, EXCLUDED.plus_minus, EXCLUDED.double_double, EXCLUDED.triple_double, EXCLUDED.did_not_play);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  UPDATE public.nba_games SET stats_synced_at=NULL WHERE id=p_game_id AND stats_synced_at IS NOT NULL;
  END IF;
  IF current_setting('app.live_feed_game',true) IS DISTINCT FROM p_game_id::text THEN
    UPDATE private.live_feed_state SET nba_player_ids=ARRAY(
      SELECT DISTINCT player FROM unnest(nba_player_ids||private.live_nba_witnesses(p_stats)) player ORDER BY player),
      espn_only_player_ids=ARRAY(SELECT player FROM unnest(espn_only_player_ids) player
        WHERE NOT player=ANY(private.live_nba_witnesses(p_stats)))
      WHERE game_id=p_game_id AND players_initialized
        AND (NOT private.live_nba_witnesses(p_stats)<@nba_player_ids OR private.live_nba_witnesses(p_stats)&&espn_only_player_ids);
    IF v_changed>0 THEN
      INSERT INTO private.live_feed_audit(game_id,source,source_updated_at,elapsed_seconds,stat_rows_changed,scoreboard_changed)
        VALUES(p_game_id,'nba',NULL,p_elapsed_seconds,v_changed,false);
    END IF;
  END IF;
  UPDATE public.nba_games SET live_stats_elapsed_seconds=p_elapsed_seconds WHERE id=p_game_id AND live_stats_elapsed_seconds IS DISTINCT FROM p_elapsed_seconds;
  RETURN v_changed;
END;
$$;
