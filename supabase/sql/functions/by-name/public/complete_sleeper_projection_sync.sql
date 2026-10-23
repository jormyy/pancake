CREATE OR REPLACE FUNCTION public.complete_sleeper_projection_sync(
  p_run_id uuid, p_rows jsonb, p_row_count integer, p_unmatched_count integer,
  p_http_status integer, p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_run public.projection_sync_runs%ROWTYPE; v_count integer;
BEGIN
  SELECT * INTO STRICT v_run FROM public.projection_sync_runs WHERE id=p_run_id FOR UPDATE;
  IF v_run.source <> 'sleeper' OR v_run.status <> 'running' OR jsonb_typeof(p_rows) <> 'array'
    OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 10000
    OR p_row_count <> jsonb_array_length(p_rows) + p_unmatched_count OR p_unmatched_count < 0
    OR p_http_status NOT BETWEEN 200 AND 299 THEN
    RAISE EXCEPTION 'Invalid Sleeper completion';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::public.sleeper_projection_rows,p_rows) r
    WHERE r.season_year IS DISTINCT FROM v_run.season_year OR r.week_number IS DISTINCT FROM v_run.week_number) THEN
    RAISE EXCEPTION 'Sleeper rows do not match their run';
  END IF;
  INSERT INTO public.sleeper_projection_rows AS stored (player_id, source_game_id, sleeper_id, season_year, week_number, game_date, team, opponent, points, rebounds, assists, steals, blocks, three_pointers_made, turnovers, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted, three_pointers_attempted, minutes, double_doubles, triple_doubles, last_modified)
  SELECT player_id, source_game_id, sleeper_id, season_year, week_number, game_date, team, opponent, points, rebounds, assists, steals, blocks, three_pointers_made, turnovers, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted, three_pointers_attempted, minutes, double_doubles, triple_doubles, last_modified FROM jsonb_populate_recordset(NULL::public.sleeper_projection_rows,p_rows)
  ON CONFLICT (player_id, source_game_id) DO UPDATE SET
    sleeper_id = EXCLUDED.sleeper_id,
    season_year = EXCLUDED.season_year,
    week_number = EXCLUDED.week_number,
    game_date = EXCLUDED.game_date,
    team = EXCLUDED.team,
    opponent = EXCLUDED.opponent,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    three_pointers_made = EXCLUDED.three_pointers_made,
    turnovers = EXCLUDED.turnovers,
    field_goals_made = EXCLUDED.field_goals_made,
    field_goals_attempted = EXCLUDED.field_goals_attempted,
    free_throws_made = EXCLUDED.free_throws_made,
    free_throws_attempted = EXCLUDED.free_throws_attempted,
    three_pointers_attempted = EXCLUDED.three_pointers_attempted,
    minutes = EXCLUDED.minutes,
    double_doubles = EXCLUDED.double_doubles,
    triple_doubles = EXCLUDED.triple_doubles,
    last_modified = EXCLUDED.last_modified,
    fetched_at = now()
  WHERE EXCLUDED.last_modified >= stored.last_modified;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE public.projection_sync_runs SET status='success', completed_at=now(), row_count=p_row_count,
    matched_count=jsonb_array_length(p_rows), unmatched_count=p_unmatched_count, http_status=p_http_status,
    source_metadata=p_metadata WHERE id=p_run_id;
  RETURN v_count;
END;
$$;
