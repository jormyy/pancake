CREATE OR REPLACE FUNCTION public.publish_nba_schedule_atomic(p_season_year int,p_games jsonb,p_weeks jsonb)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_games jsonb; v_weeks jsonb; v_count int; v_status_text jsonb; v_complete boolean;
BEGIN
  PERFORM private.lock_nba_source(p_season_year);
  PERFORM public.assert_nba_game_imports(p_games);
  IF jsonb_typeof(p_weeks) IS DISTINCT FROM 'array' OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_games) AS game(season_year int,week_number int)
      WHERE season_year IS DISTINCT FROM p_season_year OR week_number IS NULL OR week_number<1
  ) OR (SELECT count(DISTINCT row->>'nba_game_id') FROM jsonb_array_elements(p_games) row)<>jsonb_array_length(p_games) THEN
    RAISE EXCEPTION 'A complete schedule with unique game IDs and positive weeks is required.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_weeks) AS week(season_year int,week_number int,week_start date,week_end date)
      WHERE season_year IS DISTINCT FROM p_season_year OR week_number IS NULL OR week_number<1
        OR week_start IS NULL OR week_end IS NULL OR week_start>week_end) THEN
    RAISE EXCEPTION 'Schedule week ranges are invalid.' USING ERRCODE='22023';
  END IF;

  SELECT jsonb_array_length(p_games)>=1200 AND bool_and(COALESCE((game->>'schedule_complete')::boolean,false))
    AND (SELECT count(*)=30 AND min(appearances)>=80 FROM (
      SELECT team,count(*) AS appearances FROM (
        SELECT game->>'home_team' AS team FROM jsonb_array_elements(p_games) game
        UNION ALL SELECT game->>'away_team' FROM jsonb_array_elements(p_games) game
      ) teams GROUP BY team
    ) counts) INTO v_complete FROM jsonb_array_elements(p_games) game;

  IF EXISTS(SELECT 1 FROM season_weeks WHERE season_year=p_season_year) THEN
    SELECT COALESCE(jsonb_agg(incoming.value||jsonb_build_object('week_number',COALESCE(calendar.week_number,(incoming.value->>'week_number')::int))),'[]'::jsonb)
      INTO p_games FROM jsonb_array_elements(p_games) incoming(value)
      LEFT JOIN nba_games stored ON stored.nba_game_id=incoming.value->>'nba_game_id'
      LEFT JOIN LATERAL (
        SELECT week_number+CASE WHEN (incoming.value->>'game_date')::date>week_end
          THEN GREATEST(0,(date_trunc('week',(incoming.value->>'game_date')::date)::date-date_trunc('week',week_end)::date)/7) ELSE 0 END AS week_number
        FROM season_weeks week WHERE week.season_year=p_season_year
          AND (v_complete OR (stored.nba_game_id IS NOT NULL AND stored.game_date IS DISTINCT FROM (incoming.value->>'game_date')::date))
        ORDER BY CASE WHEN (incoming.value->>'game_date')::date BETWEEN week_start AND week_end THEN 0
          ELSE LEAST(abs((incoming.value->>'game_date')::date-week_start),abs((incoming.value->>'game_date')::date-week_end))+1 END,
          week_number LIMIT 1
      ) calendar ON true;
    IF v_complete THEN p_weeks:='[]'::jsonb; END IF;
  END IF;

  -- Retained games participate even when this provider does not list them.
  WITH existing AS (SELECT * FROM nba_games WHERE season_year=p_season_year),
  incoming AS (SELECT row AS value,row->>'nba_game_id' AS provider_id FROM jsonb_array_elements(p_games) row)
  SELECT COALESCE(jsonb_agg(COALESCE(to_jsonb(existing),'{}'::jsonb)||COALESCE(incoming.value,'{}'::jsonb)),'[]'::jsonb)
    INTO v_games FROM existing FULL JOIN incoming ON existing.nba_game_id=incoming.provider_id;

  IF EXISTS (
    SELECT 1 FROM nba_games old_game
      JOIN jsonb_to_recordset(v_games) AS game(nba_game_id text,week_number int,game_date date) USING(nba_game_id)
    WHERE old_game.season_year=p_season_year AND game.week_number<>old_game.week_number
      AND EXISTS(SELECT 1 FROM season_weeks week WHERE week.season_year=p_season_year
        AND week.week_number=old_game.week_number AND old_game.game_date BETWEEN week.week_start AND week.week_end)
      AND game.game_date IS NOT DISTINCT FROM old_game.game_date
  ) THEN
    RAISE EXCEPTION 'Calendar resolution required: this schedule changes a retained game week. Existing calendar is preserved.' USING ERRCODE='55000';
  END IF;

  -- Preserve recorded bounds and include every retained regular-season date.
  WITH ranges AS (
    SELECT week_number,week_start,week_end FROM season_weeks WHERE season_year=p_season_year
    UNION ALL SELECT week_number,week_start,week_end FROM jsonb_to_recordset(p_weeks) AS w(week_number int,week_start date,week_end date)
    UNION ALL SELECT week_number,game_date,game_date
      FROM jsonb_to_recordset(v_games) AS g(nba_game_id text,week_number int,game_date date)
      WHERE nba_game_id LIKE '002%' OR nba_game_id !~ '^00[0-9]'
  ), grouped AS (SELECT week_number,min(week_start) AS week_start,max(week_end) AS week_end FROM ranges GROUP BY week_number)
  SELECT COALESCE(jsonb_agg(to_jsonb(grouped) ORDER BY week_number),'[]'::jsonb) INTO v_weeks FROM grouped;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_weeks) AS a(week_number int,week_start date,week_end date)
    JOIN jsonb_to_recordset(v_weeks) AS b(week_number int,week_start date,week_end date) ON a.week_number<b.week_number
    WHERE a.week_end>=b.week_start
  ) OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_games) AS game(nba_game_id text,game_date date,week_number int)
    WHERE (game.nba_game_id LIKE '002%' OR game.nba_game_id !~ '^00[0-9]') AND (
      SELECT count(*) FROM jsonb_to_recordset(v_weeks) AS week(week_number int,week_start date,week_end date)
      WHERE game.game_date BETWEEN week.week_start AND week.week_end AND game.week_number=week.week_number
    )<>1
  ) THEN
    RAISE EXCEPTION 'Calendar resolution required: proposed weeks overlap or omit retained games. Existing calendar is preserved.' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(jsonb_object_agg(game->>'nba_game_id',game->'game_status_text'),'{}'::jsonb)
    INTO v_status_text FROM jsonb_array_elements(p_games) game WHERE game ? 'game_status_text';

  INSERT INTO nba_games AS stored(nba_game_id,season_year,game_date,home_team,away_team,status,game_status_text,week_number,
    started_at,game_time,bbref_home_team,bbref_away_team,updated_at)
  SELECT game.nba_game_id,p_season_year,game.game_date,game.home_team,game.away_team,game.status,game.game_status_text,game.week_number,
    game.started_at,game.game_time,game.bbref_home_team,game.bbref_away_team,clock_timestamp()
    FROM jsonb_populate_recordset(NULL::nba_games,p_games) game
  ON CONFLICT(nba_game_id) DO UPDATE SET
    season_year=EXCLUDED.season_year,game_date=EXCLUDED.game_date,home_team=EXCLUDED.home_team,away_team=EXCLUDED.away_team,
    status=EXCLUDED.status,
    game_status_text=CASE
      WHEN NOT private.lineup_game_available(stored.status,stored.game_status_text)
        AND (EXCLUDED.status IN('InProgress','Final') OR (EXCLUDED.game_date IS DISTINCT FROM stored.game_date
          AND EXCLUDED.game_time IS NOT NULL AND (EXCLUDED.game_time AT TIME ZONE 'America/New_York')::date=EXCLUDED.game_date))
        THEN CASE WHEN NOT private.lineup_game_available(EXCLUDED.status,EXCLUDED.game_status_text) THEN NULL ELSE EXCLUDED.game_status_text END
      WHEN NOT private.lineup_game_available(stored.status,stored.game_status_text) THEN stored.game_status_text
      WHEN v_status_text ? EXCLUDED.nba_game_id THEN EXCLUDED.game_status_text
      ELSE stored.game_status_text END,
    week_number=EXCLUDED.week_number,started_at=EXCLUDED.started_at,game_time=EXCLUDED.game_time,
    bbref_home_team=COALESCE(EXCLUDED.bbref_home_team,stored.bbref_home_team),bbref_away_team=COALESCE(EXCLUDED.bbref_away_team,stored.bbref_away_team),updated_at=EXCLUDED.updated_at;

  IF v_complete THEN
    UPDATE nba_games stored SET game_status_text='Cancelled: absent from complete schedule',updated_at=clock_timestamp()
      WHERE stored.season_year=p_season_year AND stored.status<>'Final'
        AND private.nba_game_provider(stored.nba_game_id)<>'bbref'
        AND (stored.nba_game_id LIKE '002%' OR stored.nba_game_id !~ '^00[0-9]')
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_games) game WHERE game->>'nba_game_id'=stored.nba_game_id)
        AND private.lineup_game_available(stored.status,stored.game_status_text);
  END IF;

  UPDATE player_game_stats stat SET week_number=game.week_number
    FROM nba_games game WHERE stat.game_id=game.id AND game.season_year=p_season_year
      AND stat.week_number IS DISTINCT FROM game.week_number;
  INSERT INTO season_weeks AS stored(season_year,week_number,week_start,week_end)
    SELECT p_season_year,week_number,week_start,week_end FROM jsonb_to_recordset(v_weeks) AS w(week_number int,week_start date,week_end date)
    ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end
      WHERE ROW(stored.week_start,stored.week_end) IS DISTINCT FROM ROW(EXCLUDED.week_start,EXCLUDED.week_end);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;
