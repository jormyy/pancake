CREATE OR REPLACE FUNCTION public.complete_sleeper_projection_sync(
  p_run_id uuid, p_rows jsonb, p_row_count integer, p_unmatched_count integer,
  p_http_status integer, p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
AS $$
DECLARE v_run public.projection_sync_runs%ROWTYPE; v_count integer;
  v_source_keys jsonb:=COALESCE(p_metadata->'seenSourceKeys','[]'::jsonb);
  v_stored_upcoming integer; v_matched_upcoming integer; v_degraded boolean;
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
  IF jsonb_typeof(v_source_keys) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid Sleeper source keys';
  END IF;
  IF jsonb_array_length(v_source_keys)>12500 OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_source_keys) key(sleeper_id text,source_game_id text)
    WHERE key.sleeper_id IS NULL OR key.source_game_id IS NULL
      OR key.sleeper_id !~ '^[0-9]+$' OR key.source_game_id !~ '^[0-9]+$'
  ) THEN RAISE EXCEPTION 'Invalid Sleeper source keys'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sleeper-projections:'||v_run.season_year||':'||v_run.week_number,0));
  IF EXISTS (SELECT 1 FROM public.projection_sync_runs newer
    WHERE newer.source='sleeper' AND newer.projection_type=v_run.projection_type
      AND newer.season_year=v_run.season_year AND newer.week_number=v_run.week_number
      AND newer.status='success' AND newer.completed_at IS NOT NULL AND newer.started_at>v_run.started_at) THEN
    UPDATE public.projection_sync_runs SET status='skipped',completed_at=now(),row_count=p_row_count,
      matched_count=jsonb_array_length(p_rows),unmatched_count=p_unmatched_count,http_status=p_http_status,
      source_metadata=(p_metadata-'seenSourceKeys')||'{"supersededSnapshot":true}'::jsonb WHERE id=p_run_id;
    RETURN 0;
  END IF;
  SELECT count(*) INTO v_stored_upcoming FROM public.sleeper_projection_rows
  WHERE season_year=v_run.season_year AND week_number=v_run.week_number
    AND game_date>=(now() AT TIME ZONE 'America/New_York')::date;
  SELECT count(*) INTO v_matched_upcoming FROM jsonb_populate_recordset(NULL::public.sleeper_projection_rows,p_rows) incoming
  WHERE incoming.game_date>=(now() AT TIME ZONE 'America/New_York')::date;
  v_degraded:=v_stored_upcoming>0 AND v_matched_upcoming::bigint*100<v_stored_upcoming::bigint*70;
  IF NOT v_degraded THEN
    DELETE FROM public.sleeper_projection_rows stored
    WHERE stored.season_year=v_run.season_year AND stored.week_number=v_run.week_number
      AND stored.game_date>=(now() AT TIME ZONE 'America/New_York')::date
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_rows) incoming(player_id uuid,source_game_id text)
        WHERE incoming.player_id=stored.player_id AND incoming.source_game_id=stored.source_game_id)
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v_source_keys) source(sleeper_id text,source_game_id text)
        WHERE source.sleeper_id=stored.sleeper_id AND source.source_game_id=stored.source_game_id);
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
  UPDATE public.projection_sync_runs SET status=CASE WHEN v_degraded THEN 'failed' ELSE 'success' END,
    error_message=CASE WHEN v_degraded THEN format('Sleeper coverage below 70%% (%s matched upcoming player-games, %s stored)',v_matched_upcoming,v_stored_upcoming) END,
    completed_at=now(), row_count=p_row_count,
    matched_count=jsonb_array_length(p_rows), unmatched_count=p_unmatched_count, http_status=p_http_status,
    source_metadata=(p_metadata-'seenSourceKeys')||jsonb_build_object('coverageGuard',jsonb_build_object(
      'storedUpcoming',v_stored_upcoming,'matchedUpcoming',v_matched_upcoming,'minimumPercent',70,'degraded',v_degraded)) WHERE id=p_run_id;
  RETURN v_count;
END;
$$;
