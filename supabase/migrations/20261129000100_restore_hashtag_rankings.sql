INSERT INTO private.work_kinds(kind,function_name) VALUES ('sync-rankings','sync-rankings');

CREATE OR REPLACE FUNCTION private.enqueue_rankings(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_local timestamp:=p_now AT TIME ZONE 'America/New_York'; v_view text;
BEGIN
  IF extract(isodow FROM v_local)=1 AND v_local::time<time '07:00' THEN RETURN; END IF;
  FOREACH v_view IN ARRAY ARRAY['POINT_3','ROOKIE','POINT_5'] LOOP
    PERFORM private.work_enqueue('sync-rankings',to_char(v_local,'IYYY-IW')||':'||v_view,p_now,jsonb_build_object('view',v_view));
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
  v_waiver record; v_waiver_day date; v_waiver_due timestamptz;
  v_utc timestamp:=p_now AT TIME ZONE 'UTC'; v_key text:=date_trunc('minute',p_now)::text;
BEGIN
  PERFORM private.enqueue_close_expired_nominations(p_now);
  PERFORM private.enqueue_stats_sync_dispatch(p_now);
  PERFORM private.enqueue_process_trades(p_now);
  PERFORM private.enqueue_pre_tipoff_optimizer(p_now);
  PERFORM private.enqueue_matchup_forecasts(p_now);
  PERFORM private.enqueue_screen_views(p_now);
  IF v_min%2=0 THEN PERFORM private.enqueue_live_poll(p_now); END IF;
  IF v_min%15=0 THEN
    PERFORM private.enqueue_daily('sync-players',6,0,p_now);
    PERFORM private.enqueue_daily('sync-trade-values',7,15,p_now);
    PERFORM private.enqueue_player_injuries(p_now);
    FOR v_waiver IN SELECT DISTINCT coalesce(timezone, 'America/Los_Angeles') AS timezone
      FROM public.leagues WHERE status IN ('active', 'playoffs', 'offseason') LOOP
      v_waiver_day := (p_now AT TIME ZONE v_waiver.timezone)::date;
      v_waiver_due := v_waiver_day::timestamp AT TIME ZONE v_waiver.timezone;
      PERFORM private.work_enqueue('process-waivers', v_waiver.timezone || ':' || v_waiver_day::text, v_waiver_due, jsonb_build_object('timezone', v_waiver.timezone, 'date', v_waiver_day));
    END LOOP;
    PERFORM private.enqueue_season_boundary(p_now);
    PERFORM private.enqueue_projection_sync(p_now);
    IF (p_now AT TIME ZONE 'America/New_York')::time>=time '06:20' AND EXISTS(
      SELECT 1 FROM public.nba_games WHERE game_date BETWEEN (p_now AT TIME ZONE 'America/New_York')::date-7
      AND (p_now AT TIME ZONE 'America/New_York')::date-1 AND nba_game_id LIKE '002%' AND status='Final'
    ) THEN
      PERFORM private.work_enqueue('daily-stat-corrections',(p_now AT TIME ZONE 'America/New_York')::date::text,p_now);
    END IF;
  END IF;
  IF v_min%15=5 THEN PERFORM private.enqueue_daily('sync-schedule',6,5,p_now); END IF;
  IF v_min%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
    WHERE reconciled_at IS NULL OR worker_status='running') THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now);
  END IF;
  IF v_min=0 THEN PERFORM private.enqueue_rankings(p_now); END IF;
  IF v_min=17 THEN PERFORM private.work_enqueue('pg-net-response-vacuum',date_trunc('hour',p_now)::text,p_now,'{"action":"vacuum"}'); END IF;
  IF v_min=0 AND extract(hour FROM v_utc)=13 AND
    ((extract(month FROM v_utc)=6 AND extract(day FROM v_utc)>=20) OR
     (extract(month FROM v_utc)=7 AND extract(day FROM v_utc)<=15)) THEN
    PERFORM private.work_enqueue('sync-draft-order',v_utc::date::text,p_now);
  END IF;
  IF extract(hour FROM v_utc)=8 AND v_min=35 THEN PERFORM private.work_enqueue('cleanup-trade-estimates',v_utc::date::text,p_now); END IF;
  IF extract(hour FROM v_utc)=9 AND v_min=30 THEN PERFORM private.work_enqueue('mock-room-expiry',v_utc::date::text,p_now); END IF;
  IF v_utc::time>=time '10:00' THEN
    PERFORM private.work_enqueue('retention-prune',v_utc::date::text,p_now);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_dynasty_rankings(
  p_source text,
  p_fetched_at timestamptz,
  p_rows jsonb,
  p_min_rows int DEFAULT 100,
  p_scoring_format text DEFAULT 'overall',
  p_source_url text DEFAULT NULL,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source text := NULLIF(trim(p_source), '');
  v_scoring_format text := lower(NULLIF(trim(p_scoring_format), ''));
  v_source_url text := NULLIF(trim(p_source_url), '');
  v_payload_count int;
  v_stage_count int;
  v_upserted int;
  v_deleted int;
  v_players_updated int;
  v_players_cleared int;
BEGIN
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'Ranking source is required';
  END IF;

  IF v_scoring_format IS NULL OR v_scoring_format NOT IN ('overall', 'points', 'category', 'custom') THEN
    RAISE EXCEPTION 'Ranking scoring format is invalid: %', p_scoring_format;
  END IF;

  IF p_source_metadata IS NULL OR jsonb_typeof(p_source_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Ranking source metadata must be a JSON object';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Ranking rows must be a JSON array';
  END IF;

  v_payload_count := jsonb_array_length(p_rows);
  IF v_payload_count < GREATEST(COALESCE(p_min_rows, 100), 1) THEN
    RAISE EXCEPTION 'Ranking row count % is below minimum %', v_payload_count, p_min_rows;
  END IF;

  WITH stage AS (
    SELECT
      CASE
        WHEN NULLIF(item ->> 'source_rank', '') ~ '^[0-9]+$' THEN (item ->> 'source_rank')::int
        ELSE NULL
      END AS source_rank,
      NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  SELECT count(*) INTO v_stage_count FROM stage;

  IF v_stage_count <> v_payload_count THEN
    RAISE EXCEPTION 'Staged ranking row count % does not match payload count %', v_stage_count, v_payload_count;
  END IF;

  IF EXISTS (
    WITH stage AS (
      SELECT
        CASE
          WHEN NULLIF(item ->> 'source_rank', '') ~ '^[0-9]+$' THEN (item ->> 'source_rank')::int
          ELSE NULL
        END AS source_rank,
        NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name
      FROM jsonb_array_elements(p_rows) AS rows(item)
    )
    SELECT 1
    FROM stage
    WHERE source_rank IS NULL OR source_rank <= 0 OR source_player_name IS NULL
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains invalid rank or player name';
  END IF;

  IF EXISTS (
    SELECT (item ->> 'source_rank')::int AS source_rank
    FROM jsonb_array_elements(p_rows) AS rows(item)
    GROUP BY (item ->> 'source_rank')::int
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Ranking payload contains duplicate source ranks';
  END IF;

  WITH stage AS (
    SELECT
      v_source AS source,
      v_scoring_format AS scoring_format,
      v_source_url AS source_url,
      p_source_metadata AS source_metadata,
      (item ->> 'source_rank')::int AS source_rank,
      NULLIF(item ->> 'source_player_id', '') AS source_player_id,
      NULLIF(trim(item ->> 'source_player_name'), '') AS source_player_name,
      NULLIF(item ->> 'source_team', '') AS source_team,
      COALESCE(
        ARRAY(
          SELECT jsonb_array_elements_text(COALESCE(item -> 'source_positions', '[]'::jsonb))
        ),
        '{}'::text[]
      ) AS source_positions,
      NULLIF(item ->> 'player_id', '')::uuid AS player_id,
      NULLIF(item ->> 'age', '')::numeric(4,1) AS age,
      COALESCE(NULLIF(item ->> 'rank_change', '')::int, 0) AS rank_change,
      NULLIF(item ->> 'games_played', '')::int AS games_played,
      NULLIF(item ->> 'field_goal_pct', '')::numeric(5,3) AS field_goal_pct,
      NULLIF(item ->> 'free_throw_pct', '')::numeric(5,3) AS free_throw_pct,
      NULLIF(item ->> 'three_pointers_made', '')::numeric(5,1) AS three_pointers_made,
      NULLIF(item ->> 'points', '')::numeric(5,1) AS points,
      NULLIF(item ->> 'rebounds', '')::numeric(5,1) AS rebounds,
      NULLIF(item ->> 'assists', '')::numeric(5,1) AS assists,
      NULLIF(item ->> 'steals', '')::numeric(5,1) AS steals,
      NULLIF(item ->> 'blocks', '')::numeric(5,1) AS blocks,
      NULLIF(item ->> 'turnovers', '')::numeric(5,1) AS turnovers,
      NULLIF(item ->> 'comment', '') AS comment,
      p_fetched_at AS fetched_at
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  INSERT INTO public.dynasty_rankings (
    source,
    scoring_format,
    source_url,
    source_metadata,
    source_rank,
    source_player_id,
    source_player_name,
    source_team,
    source_positions,
    player_id,
    age,
    rank_change,
    games_played,
    field_goal_pct,
    free_throw_pct,
    three_pointers_made,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    comment,
    fetched_at,
    updated_at
  )
  SELECT
    source,
    scoring_format,
    source_url,
    source_metadata,
    source_rank,
    source_player_id,
    source_player_name,
    source_team,
    source_positions,
    player_id,
    age,
    rank_change,
    games_played,
    field_goal_pct,
    free_throw_pct,
    three_pointers_made,
    points,
    rebounds,
    assists,
    steals,
    blocks,
    turnovers,
    comment,
    fetched_at,
    now()
  FROM stage
  ON CONFLICT (source, source_rank) DO UPDATE SET
    scoring_format = EXCLUDED.scoring_format,
    source_url = EXCLUDED.source_url,
    source_metadata = EXCLUDED.source_metadata,
    source_player_id = EXCLUDED.source_player_id,
    source_player_name = EXCLUDED.source_player_name,
    source_team = EXCLUDED.source_team,
    source_positions = EXCLUDED.source_positions,
    player_id = EXCLUDED.player_id,
    age = EXCLUDED.age,
    rank_change = EXCLUDED.rank_change,
    games_played = EXCLUDED.games_played,
    field_goal_pct = EXCLUDED.field_goal_pct,
    free_throw_pct = EXCLUDED.free_throw_pct,
    three_pointers_made = EXCLUDED.three_pointers_made,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    turnovers = EXCLUDED.turnovers,
    comment = EXCLUDED.comment,
    fetched_at = EXCLUDED.fetched_at,
    updated_at = now();
  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  WITH stage AS (
    SELECT
      (item ->> 'source_rank')::int AS source_rank
    FROM jsonb_array_elements(p_rows) AS rows(item)
  )
  DELETE FROM public.dynasty_rankings AS ranking
  WHERE ranking.source = v_source
    AND NOT EXISTS (
      SELECT 1
      FROM stage
      WHERE stage.source_rank = ranking.source_rank
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_source = 'hashtagbasketball.com' THEN
    WITH stage AS (
      SELECT
        (item ->> 'source_rank')::int AS source_rank,
        NULLIF(item ->> 'player_id', '')::uuid AS player_id
      FROM jsonb_array_elements(p_rows) AS rows(item)
    ),
    best_rank AS (
      SELECT DISTINCT ON (player_id)
        player_id,
        source_rank
      FROM stage
      WHERE player_id IS NOT NULL
      ORDER BY player_id, source_rank
    )
    UPDATE public.players AS player
       SET dynasty_rank = best_rank.source_rank,
           dynasty_rank_source = v_source,
           dynasty_rank_fetched_at = p_fetched_at
      FROM best_rank
     WHERE player.id = best_rank.player_id;
    GET DIAGNOSTICS v_players_updated = ROW_COUNT;

    WITH stage AS (
      SELECT
        NULLIF(item ->> 'player_id', '')::uuid AS player_id
      FROM jsonb_array_elements(p_rows) AS rows(item)
    )
    UPDATE public.players AS player
       SET dynasty_rank = NULL,
           dynasty_rank_source = NULL,
           dynasty_rank_fetched_at = NULL
     WHERE player.dynasty_rank_source = v_source
       AND NOT EXISTS (
         SELECT 1
         FROM stage
         WHERE stage.player_id = player.id
       );
    GET DIAGNOSTICS v_players_cleared = ROW_COUNT;
  ELSE
    v_players_updated := 0;
    v_players_cleared := 0;
  END IF;

  RETURN jsonb_build_object(
    'rows', v_stage_count,
    'scoringFormat', v_scoring_format,
    'sourceUrl', v_source_url,
    'upserted', v_upserted,
    'deleted', v_deleted,
    'playersUpdated', v_players_updated,
    'playersCleared', v_players_cleared
  );
END;
$$;

REVOKE ALL ON FUNCTION private.enqueue_rankings(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text,timestamptz,jsonb,integer,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text,timestamptz,jsonb,integer,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.get_dynasty_forecast_inputs(
  p_league_id uuid,
  p_member_id uuid,
  p_season_year int DEFAULT public.current_season_year_et(),
  p_player_ids uuid[] DEFAULT NULL,
  p_query text DEFAULT '',
  p_limit int DEFAULT 600,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  player_id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  injury_status text,
  years_exp int,
  headshot_url text,
  nba_id text,
  dynasty_ranking_id uuid,
  five_year_rank int,
  three_year_rank int,
  rookie_rank int,
  rank_change int,
  age numeric,
  ranking_source text,
  ranking_fetched_at timestamptz,
  games_played numeric,
  avg_points numeric,
  avg_rebounds numeric,
  avg_assists numeric,
  avg_steals numeric,
  avg_blocks numeric,
  avg_three_pointers_made numeric,
  avg_turnovers numeric,
  avg_field_goals_made numeric,
  avg_field_goals_attempted numeric,
  avg_free_throws_made numeric,
  avg_free_throws_attempted numeric,
  avg_fantasy_points numeric,
  projection_fantasy_points numeric,
  projection_fetched_at timestamptz,
  projection_source text,
  trade_value numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH authorized AS (
  SELECT 1
    FROM public.league_members AS own_member
   WHERE own_member.id = p_member_id
     AND own_member.league_id = p_league_id
     AND own_member.user_id = (SELECT auth.uid())
),
candidate_ids AS (
  SELECT ranking.player_id, min(ranking.source_rank) AS sort_rank
    FROM authorized
    JOIN public.dynasty_rankings AS ranking
      ON ranking.source IN (
        'hashtagbasketball.com',
        'hashtagbasketball.com/points-3',
        'hashtagbasketball.com/rookie'
      )
     AND ranking.player_id IS NOT NULL
   WHERE p_player_ids IS NULL
   GROUP BY ranking.player_id
  UNION ALL
  SELECT requested.player_id, NULL::int
    FROM authorized
    CROSS JOIN LATERAL (
      SELECT DISTINCT player_id
        FROM unnest(p_player_ids) AS ids(player_id)
    ) AS requested
   WHERE p_player_ids IS NOT NULL
),
bounded_players AS (
  SELECT
    player.id,
    COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name)) AS display_name,
    player.nba_team,
    player.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(player.eligible_positions) AS pos) AS eligible_positions,
    player.injury_status,
    player.years_exp,
    player.headshot_url,
    player.nba_id,
    five_year.id AS dynasty_ranking_id,
    five_year.source_rank AS five_year_rank,
    three_year.source_rank AS three_year_rank,
    rookie.source_rank AS rookie_rank,
    five_year.rank_change,
    five_year.age,
    five_year.source AS ranking_source,
    five_year.fetched_at AS ranking_fetched_at,
    five_year.trade_value
  FROM candidate_ids AS candidate
  JOIN public.players AS player ON player.id = candidate.player_id
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS five_year ON true
  LEFT JOIN LATERAL (
    SELECT ranking.source_rank
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com/points-3'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS three_year ON true
  LEFT JOIN LATERAL (
    SELECT ranking.source_rank
      FROM public.dynasty_rankings AS ranking
     WHERE ranking.player_id = player.id
       AND ranking.source = 'hashtagbasketball.com/rookie'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) AS rookie ON true
  WHERE COALESCE(trim(p_query), '') = ''
     OR player.display_name ILIKE '%' || trim(p_query) || '%'
  ORDER BY candidate.sort_rank NULLS LAST, player.display_name, player.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 600), 1), 1000)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
),
bounded_ids AS (
  SELECT array_agg(id ORDER BY id) AS player_ids
    FROM bounded_players
),
projections AS (
  SELECT projection.*
    FROM bounded_ids AS ids
    CROSS JOIN LATERAL public.get_league_projection_rows(
      p_league_id,
      p_season_year,
      (timezone('America/New_York', now()))::date,
      'today',
      ids.player_ids,
      1000,
      0
    ) AS projection
   WHERE ids.player_ids IS NOT NULL
)
SELECT
  player.id,
  player.display_name,
  player.nba_team,
  player.position,
  player.eligible_positions,
  player.injury_status,
  player.years_exp,
  player.headshot_url,
  player.nba_id,
  player.dynasty_ranking_id,
  player.five_year_rank,
  player.three_year_rank,
  player.rookie_rank,
  player.rank_change,
  player.age,
  player.ranking_source,
  player.ranking_fetched_at,
  average.games_played,
  average.avg_points,
  average.avg_rebounds,
  average.avg_assists,
  average.avg_steals,
  average.avg_blocks,
  average.avg_three_pointers_made,
  average.avg_turnovers,
  average.avg_field_goals_made,
  average.avg_field_goals_attempted,
  average.avg_free_throws_made,
  average.avg_free_throws_attempted,
  fantasy.avg_fantasy_points,
  projection.projection_fantasy_points,
  projection.projection_fetched_at,
  projection.projection_source,
  player.trade_value
FROM bounded_players AS player
LEFT JOIN public.mv_player_season_averages AS average
  ON average.player_id = player.id
 AND average.season_year = p_season_year
LEFT JOIN public.v_player_avg_fantasy_points AS fantasy
  ON fantasy.player_id = player.id
 AND fantasy.league_id = p_league_id
 AND fantasy.season_year = p_season_year
LEFT JOIN projections AS projection ON projection.player_id = player.id
ORDER BY player.five_year_rank NULLS LAST, player.display_name, player.id;
$$;

REVOKE ALL ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_dynasty_forecast_inputs(uuid, uuid, int, uuid[], text, int, int) IS
  'Returns authorized Hashtag dynasty ranks, production, and projections.';

CREATE OR REPLACE FUNCTION public.publish_trade_values(p_rows jsonb,p_picks jsonb,p_source_body text,p_fetched_at timestamptz,p_mode text,p_request_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_state private.trade_value_sync_state%ROWTYPE; v_matched integer; v_duplicates integer;
BEGIN
  SELECT * INTO v_state FROM private.trade_value_sync_state WHERE id FOR UPDATE;
  IF p_mode IS NULL OR p_mode NOT IN ('live','json','csv')
    OR p_source_body IS NULL OR length(p_source_body) NOT BETWEEN 1 AND 2000000 OR p_fetched_at IS NULL OR p_fetched_at>clock_timestamp()+interval '5 minutes'
    OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_typeof(p_picks) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_rows)<>450 OR jsonb_array_length(p_picks)<>18 THEN
    RAISE EXCEPTION 'Trade value snapshot must contain 450 players and 18 picks.' USING ERRCODE='22023';
  END IF;
  IF p_mode='live' AND (p_request_id IS NULL OR p_request_id IS DISTINCT FROM v_state.request_id) THEN
    RAISE EXCEPTION 'Trade value fetch claim has expired.' USING ERRCODE='40001';
  END IF;
  IF v_state.fetched_at>=p_fetched_at THEN RETURN jsonb_build_object('stale',true); END IF;
  DROP TABLE IF EXISTS pg_temp.trade_value_players;
  CREATE TEMP TABLE trade_value_players ON COMMIT DROP AS
    SELECT * FROM jsonb_to_recordset(p_rows) AS row(source_id text,name text,team text,positions text[],rank integer,
      value numeric,age numeric,player_id uuid,reason text,candidate_ids uuid[]);
  DROP TABLE IF EXISTS pg_temp.trade_value_picks;
  CREATE TEMP TABLE trade_value_picks ON COMMIT DROP AS
    SELECT * FROM jsonb_to_recordset(p_picks) AS row(year integer,round integer,tier text,value numeric);
  IF EXISTS(SELECT 1 FROM pg_temp.trade_value_players WHERE source_id IS NULL OR btrim(name)='' OR name IS NULL
      OR rank IS NULL OR rank NOT BETWEEN 1 AND 468 OR value IS NULL OR value NOT BETWEEN 0 AND 1000
      OR cardinality(positions)=0 OR positions IS NULL OR team IS NULL)
    OR EXISTS(SELECT 1 FROM pg_temp.trade_value_picks WHERE year IS NULL OR round IS NULL OR round NOT IN(1,2)
      OR tier IS NULL OR tier NOT IN('early','mid','late') OR value IS NULL OR value NOT BETWEEN 0 AND 1000)
    OR (SELECT count(DISTINCT (year,round,tier)) FROM pg_temp.trade_value_picks)<>18
    OR (SELECT count(DISTINCT year) FROM pg_temp.trade_value_picks)<>3
    OR (SELECT max(year)-min(year) FROM pg_temp.trade_value_picks)<>2
    OR (SELECT count(DISTINCT source_id) FROM pg_temp.trade_value_players)<>450
    OR (SELECT count(DISTINCT rank) FROM pg_temp.trade_value_players)<>450 THEN
    RAISE EXCEPTION 'Trade value snapshot violates the source contract.' USING ERRCODE='22023';
  END IF;
  UPDATE pg_temp.trade_value_players stage SET player_id=review.resolved_player_id
    FROM public.trade_value_reviews review WHERE review.source_id=stage.source_id AND review.resolved_player_id IS NOT NULL;
  SELECT count(player_id)-count(DISTINCT player_id) INTO v_duplicates FROM pg_temp.trade_value_players;
  IF v_duplicates<>0 THEN RAISE EXCEPTION 'A player cannot receive two source values.' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.trade_value_players row LEFT JOIN public.players player ON player.id=row.player_id
    WHERE row.player_id IS NOT NULL AND player.id IS NULL) THEN
    RAISE EXCEPTION 'A matched player no longer exists.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.dynasty_rankings(source,source_rank,source_player_id,source_player_name,source_team,source_positions,
    player_id,age,scoring_format,source_url,source_metadata,trade_value,fetched_at)
  SELECT 'onenumberhoops.com',rank,source_id,name,team,positions,player_id,age,'overall',
    'https://www.onenumberhoops.com/rankings',jsonb_build_object('importMode',p_mode,'scaleDivisor',10),value,p_fetched_at
  FROM pg_temp.trade_value_players
  ON CONFLICT(source,source_rank) DO UPDATE SET source_player_id=EXCLUDED.source_player_id,
    source_player_name=EXCLUDED.source_player_name,source_team=EXCLUDED.source_team,source_positions=EXCLUDED.source_positions,
    player_id=EXCLUDED.player_id,age=EXCLUDED.age,source_metadata=EXCLUDED.source_metadata,
    trade_value=EXCLUDED.trade_value,fetched_at=EXCLUDED.fetched_at,updated_at=clock_timestamp();
  DELETE FROM public.dynasty_rankings WHERE source='onenumberhoops.com'
    AND source_rank NOT IN(SELECT rank FROM pg_temp.trade_value_players);
  DELETE FROM public.trade_value_reviews WHERE resolved_player_id IS NULL
    AND source_id NOT IN(SELECT source_id FROM pg_temp.trade_value_players WHERE player_id IS NULL);
  INSERT INTO public.trade_value_reviews(source_id,source_name,source_team,source_positions,trade_value,reason,candidate_ids,fetched_at)
  SELECT source_id,name,team,positions,value,reason,COALESCE(candidate_ids,'{}'),p_fetched_at
    FROM pg_temp.trade_value_players WHERE player_id IS NULL
  ON CONFLICT(source_id) DO UPDATE SET source_name=EXCLUDED.source_name,source_team=EXCLUDED.source_team,
    source_positions=EXCLUDED.source_positions,trade_value=EXCLUDED.trade_value,reason=EXCLUDED.reason,
    candidate_ids=EXCLUDED.candidate_ids,fetched_at=EXCLUDED.fetched_at;
  DELETE FROM public.dynasty_pick_values WHERE source='onenumberhoops.com';
  INSERT INTO public.dynasty_pick_values(draft_year,round,tier,trade_value,derived,fetched_at)
    SELECT year,round,tier,value,false,p_fetched_at FROM pg_temp.trade_value_picks
    UNION ALL SELECT year,3,tier,round(value*0.4,2),true,p_fetched_at FROM pg_temp.trade_value_picks WHERE round=2;
  SELECT count(*) INTO v_matched FROM pg_temp.trade_value_players WHERE player_id IS NOT NULL;
  UPDATE private.trade_value_sync_state SET fetched_at=p_fetched_at,source_body=p_source_body,mode=p_mode,
    matched=v_matched,content_sha256=encode(extensions.digest(p_source_body,'sha256'),'hex') WHERE id;
  INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
    SELECT id,'resources',1,NULL,NULL FROM public.leagues WHERE deleted_at IS NULL
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,scopes=NULL,details=NULL,updated_at=clock_timestamp();
  PERFORM private.work_enqueue('pick-predictions',to_char(p_fetched_at AT TIME ZONE 'America/New_York','YYYY-MM-DD')||':'||encode(extensions.digest(p_source_body,'sha256'),'hex'),now(),
    jsonb_build_object('sourceVersion',encode(extensions.digest(p_source_body,'sha256'),'hex')));
  RETURN jsonb_build_object('players',450,'matched',v_matched,'unmatched',450-v_matched,'picks',18,'derivedPicks',9);
END;
$$;
REVOKE ALL ON FUNCTION public.publish_trade_values(jsonb,jsonb,text,timestamptz,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_trade_values(jsonb,jsonb,text,timestamptz,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_trade_value_review(p_source_id text,p_player_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
    WHERE member.user_id=auth.uid() AND league.deleted_at IS NULL AND member.role IN('commissioner','co_commissioner'))
    AND COALESCE(auth.jwt()->'app_metadata'->>'role','')<>'admin' THEN
    RAISE EXCEPTION 'Only commissioners and admins can resolve value matches.' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM private.trade_value_sync_state WHERE id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.players WHERE id=p_player_id) THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.dynasty_rankings WHERE source='onenumberhoops.com' AND player_id=p_player_id AND source_player_id<>p_source_id) THEN
    RAISE EXCEPTION 'Player already has a source value.' USING ERRCODE='22023';
  END IF;
  UPDATE public.trade_value_reviews SET resolved_player_id=p_player_id,resolved_by=auth.uid(),resolved_at=clock_timestamp()
    WHERE source_id=p_source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review not found.' USING ERRCODE='22023'; END IF;
  UPDATE public.dynasty_rankings SET player_id=p_player_id,updated_at=clock_timestamp()
    WHERE source='onenumberhoops.com' AND source_player_id=p_source_id;
  INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
    SELECT id,'resources',1,NULL,NULL FROM public.leagues WHERE deleted_at IS NULL
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,scopes=NULL,details=NULL,updated_at=clock_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_trade_value_review(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_trade_value_review(text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.view_player(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; player public.players%ROWTYPE; average jsonb; fantasy numeric; lines jsonb; transactions jsonb; projection jsonb;
  games jsonb; fantasy_map jsonb;
BEGIN
  IF p_params->>'section' IN ('overview', 'games', 'news', 'history') THEN
    DECLARE
      context jsonb; player public.players%ROWTYPE; average jsonb; fantasy numeric; projection jsonb;
      items jsonb; own public.roster_players%ROWTYPE; owner_name text; waiver_time timestamptz;
      page_size integer := LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100);
    BEGIN
      context := public.view_context(p_league_id, p_member_id, p_params || jsonb_build_object('seasonYear', COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())));
      SELECT * INTO player FROM public.players WHERE id = (p_params->>'playerId')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
      IF p_params->>'section' = 'games' THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(stat) - 'game_id' || jsonb_build_object('nba_games', to_jsonb(game)) ORDER BY stat.game_date DESC, stat.id DESC), '[]')
          INTO items FROM (SELECT stat.* FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id
            WHERE stat.player_id = player.id AND stat.season_year = (context->>'seasonYear')::integer AND game.nba_game_id LIKE '002%'
            ORDER BY stat.game_date DESC, stat.id DESC LIMIT page_size + 1) stat JOIN public.nba_games game ON game.id = stat.game_id;
        RETURN jsonb_build_object('context', context, 'lines', items, 'hasMoreGames', jsonb_array_length(items) > page_size);
      ELSIF p_params->>'section' = 'news' THEN
        SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.published_at DESC, item.id), '[]') INTO items
          FROM (SELECT id, title, summary, source, url, published_at FROM public.dynasty_news
            WHERE player_id = player.id ORDER BY published_at DESC, id LIMIT 20) item;
        RETURN jsonb_build_object('context', context, 'news', items);
      ELSIF p_params->>'section' = 'history' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'transactionType', t.transaction_type, 'label', CASE t.transaction_type
          WHEN 'fa_add' THEN 'Added' WHEN 'fa_drop' THEN 'Dropped' WHEN 'waiver_add' THEN 'Claimed' WHEN 'waiver_drop' THEN 'Dropped'
          WHEN 'trade_in' THEN 'Acquired via Trade' WHEN 'trade_out' THEN 'Traded Away' WHEN 'ir_designate' THEN 'Placed on IR'
          WHEN 'ir_return' THEN 'Activated from IR' WHEN 'taxi_designate' THEN 'Placed on Taxi Squad' WHEN 'taxi_return' THEN 'Activated from Taxi Squad'
          WHEN 'draft_won' THEN 'Drafted' WHEN 'carry_over' THEN 'Carried Over' ELSE t.transaction_type END,
          'teamName', COALESCE(member.team_name, 'Unknown'), 'occurredAt', t.occurred_at) ORDER BY t.occurred_at DESC, t.id DESC), '[]') INTO items
          FROM (SELECT * FROM public.roster_transactions WHERE league_id = p_league_id AND player_id = player.id
            ORDER BY occurred_at DESC, id DESC LIMIT 20) t LEFT JOIN public.league_members member ON member.id = t.member_id;
        RETURN jsonb_build_object('context', context, 'transactions', items);
      END IF;
      SELECT averages, avg_fantasy_points INTO average, fantasy FROM public.player_season_averages
        WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
      IF NOT FOUND THEN
        SELECT to_jsonb(row) INTO average FROM public.mv_player_season_averages row WHERE player_id = player.id AND season_year = (context->>'seasonYear')::integer;
        SELECT avg_fantasy_points INTO fantasy FROM public.v_player_avg_fantasy_points WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
      END IF;
      SELECT to_jsonb(row) INTO projection FROM public.get_league_projection_rows(p_league_id, public.current_season_year_et(),
        (context->>'today')::date, 'today', ARRAY[player.id], 1, 0) row;
      SELECT r.* INTO own FROM public.roster_players r WHERE r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid AND r.player_id = player.id LIMIT 1;
      SELECT team_name INTO owner_name FROM public.league_members WHERE id = own.member_id;
      SELECT max(clears_at) INTO waiver_time FROM public.waiver_wire_log WHERE league_id = p_league_id AND player_id = player.id AND cleared_at IS NULL AND clears_at > now() AND league_season_id = (context->>'seasonId')::uuid;
      RETURN jsonb_build_object('context', context, 'player', to_jsonb(player) || jsonb_build_object('display_name', COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name)),
        'five_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1),
        'three_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com/points-3' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)),
        'availableSeasons', COALESCE((SELECT jsonb_agg(season_year ORDER BY season_year DESC) FROM (
          SELECT season_year FROM public.mv_player_season_averages WHERE player_id = player.id UNION SELECT public.current_season_year_et()) years), '[]'),
        'averages', CASE WHEN COALESCE((average->>'games_played')::integer, 0) > 0 THEN jsonb_build_object(
          'gamesPlayed', average->'games_played', 'avgPoints', COALESCE(NULLIF(average->'avg_points', 'null'), '0'), 'avgRebounds', COALESCE(NULLIF(average->'avg_rebounds', 'null'), '0'),
          'avgAssists', COALESCE(NULLIF(average->'avg_assists', 'null'), '0'), 'avgSteals', COALESCE(NULLIF(average->'avg_steals', 'null'), '0'), 'avgBlocks', COALESCE(NULLIF(average->'avg_blocks', 'null'), '0'),
          'avgTurnovers', COALESCE(NULLIF(average->'avg_turnovers', 'null'), '0'), 'avgThreePointersMade', COALESCE(NULLIF(average->'avg_three_pointers_made', 'null'), '0'),
          'avgFieldGoalsMade', COALESCE(NULLIF(average->'avg_field_goals_made', 'null'), '0'), 'avgFieldGoalsAttempted', COALESCE(NULLIF(average->'avg_field_goals_attempted', 'null'), '0'),
          'avgFreeThrowsMade', COALESCE(NULLIF(average->'avg_free_throws_made', 'null'), '0'), 'avgFreeThrowsAttempted', COALESCE(NULLIF(average->'avg_free_throws_attempted', 'null'), '0'),
          'avgMinutesPlayed', COALESCE(NULLIF(average->'avg_minutes_played', 'null'), '0'), 'doubleDoubles', COALESCE(NULLIF(average->'double_doubles', 'null'), '0'), 'tripleDoubles', COALESCE(NULLIF(average->'triple_doubles', 'null'), '0')) END,
        'avgFantasyPoints', fantasy, 'nextProjection', projection, 'scoringSettings', context->'league'->'scoring_settings',
        'pickup', jsonb_build_object('status', CASE WHEN own.member_id = p_member_id THEN jsonb_build_object('status', 'mine', 'rosterPlayerId', own.id, 'isOnTaxi', own.is_on_taxi)
          WHEN own.id IS NOT NULL THEN jsonb_build_object('status', 'taken', 'ownerTeamName', COALESCE(owner_name, 'Team'), 'isOnTaxi', own.is_on_taxi)
          WHEN waiver_time IS NOT NULL THEN jsonb_build_object('status', 'on_waivers', 'logId', '', 'clearsAt', waiver_time) ELSE jsonb_build_object('status', 'free_agent') END,
          'transactionState', public.view_transaction_state(p_league_id, p_member_id, p_params),
          'claimPending', EXISTS (SELECT 1 FROM public.waiver_claims WHERE member_id = p_member_id AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid AND player_id = player.id AND status = 'pending'),
          'roster', COALESCE((SELECT jsonb_agg(jsonb_build_object('is_on_ir', is_on_ir, 'is_on_taxi', is_on_taxi)) FROM public.roster_players WHERE member_id = p_member_id AND league_id = p_league_id AND league_season_id = (context->>'seasonId')::uuid), '[]')));
    END;
  END IF;
  context := public.view_context(p_league_id, p_member_id,
    p_params || jsonb_build_object('seasonYear', COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())));
  SELECT * INTO player FROM public.players WHERE id = (p_params->>'playerId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT averages, avg_fantasy_points INTO average, fantasy FROM public.player_season_averages
    WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  IF NOT FOUND THEN
    SELECT to_jsonb(row) INTO average FROM public.mv_player_season_averages row WHERE player_id = player.id AND season_year = (context->>'seasonYear')::integer;
    SELECT avg_fantasy_points INTO fantasy FROM public.v_player_avg_fantasy_points WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(stat) - 'game_id' || jsonb_build_object('nba_games', to_jsonb(game)) ORDER BY stat.game_date DESC, stat.id DESC), '[]')
    INTO lines FROM (SELECT stat.* FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id
      WHERE stat.player_id = player.id AND stat.season_year = (context->>'seasonYear')::integer AND game.nba_game_id LIKE '002%'
      ORDER BY stat.game_date DESC, stat.id DESC LIMIT 100) stat JOIN public.nba_games game ON game.id = stat.game_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'transactionType', t.transaction_type, 'label', CASE t.transaction_type
    WHEN 'fa_add' THEN 'Added' WHEN 'fa_drop' THEN 'Dropped' WHEN 'waiver_add' THEN 'Claimed' WHEN 'waiver_drop' THEN 'Dropped'
    WHEN 'trade_in' THEN 'Acquired via Trade' WHEN 'trade_out' THEN 'Traded Away' WHEN 'ir_designate' THEN 'Placed on IR'
    WHEN 'ir_return' THEN 'Activated from IR' WHEN 'taxi_designate' THEN 'Placed on Taxi Squad' WHEN 'taxi_return' THEN 'Activated from Taxi Squad'
    WHEN 'draft_won' THEN 'Drafted' WHEN 'carry_over' THEN 'Carried Over' ELSE t.transaction_type END,
    'teamName', COALESCE(member.team_name, 'Unknown'), 'occurredAt', t.occurred_at) ORDER BY t.occurred_at DESC, t.id DESC), '[]')
    INTO transactions FROM (SELECT * FROM public.roster_transactions WHERE league_id = p_league_id AND player_id = player.id
      ORDER BY occurred_at DESC, id DESC LIMIT 20) t LEFT JOIN public.league_members member ON member.id = t.member_id;
  SELECT to_jsonb(row) INTO projection FROM public.get_league_projection_rows(p_league_id, public.current_season_year_et(),
    (context->>'today')::date, 'today', ARRAY[player.id], 1, 0) row;
  WITH ordered AS (
    SELECT line, line->'nba_games' AS game, COALESCE((line->>'is_home')::boolean,
      CASE WHEN line->'nba_games'->>'home_team' = player.nba_team THEN true WHEN line->'nba_games'->>'away_team' = player.nba_team THEN false END) AS home
    FROM jsonb_array_elements(lines) line
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('gameId', line->'id', 'nbaGameId', game->'id', 'gameDate', game->'game_date',
    'opponent', CASE WHEN home THEN 'vs ' || (game->>'away_team') WHEN home = false THEN '@ ' || (game->>'home_team')
      ELSE (game->>'away_team') || ' @ ' || (game->>'home_team') END, 'isHome', COALESCE(home, false),
    'live', replace(lower(game->>'status'), '_', '') = 'inprogress', 'didNotPlay', line->'did_not_play',
    'minutes', line->'minutes_played', 'points', COALESCE(NULLIF(line->'points', 'null'), '0'), 'rebounds', COALESCE(NULLIF(line->'rebounds', 'null'), '0'),
    'assists', COALESCE(NULLIF(line->'assists', 'null'), '0'), 'steals', COALESCE(NULLIF(line->'steals', 'null'), '0'), 'blocks', COALESCE(NULLIF(line->'blocks', 'null'), '0'),
    'turnovers', COALESCE(NULLIF(line->'turnovers', 'null'), '0'), 'personalFouls', COALESCE(NULLIF(line->'personal_fouls', 'null'), '0'),
    'fgMade', COALESCE(NULLIF(line->'field_goals_made', 'null'), '0'), 'fgAttempted', COALESCE(NULLIF(line->'field_goals_attempted', 'null'), '0'),
    'threeMade', COALESCE(NULLIF(line->'three_pointers_made', 'null'), '0'), 'threeAttempted', COALESCE(NULLIF(line->'three_pointers_attempted', 'null'), '0'),
    'ftMade', COALESCE(NULLIF(line->'free_throws_made', 'null'), '0'), 'ftAttempted', COALESCE(NULLIF(line->'free_throws_attempted', 'null'), '0'),
    'plusMinus', COALESCE(NULLIF(line->'plus_minus', 'null'), '0'), 'doubleDouble', COALESCE(NULLIF(line->'double_double', 'null'), 'false'),
    'tripleDouble', COALESCE(NULLIF(line->'triple_double', 'null'), 'false')) ORDER BY game->>'game_date' DESC, line->>'id' DESC), '[]'),
    COALESCE(jsonb_object_agg(line->>'id', public.compute_fantasy_points((line->>'id')::uuid, p_league_id)), '{}')
    INTO games, fantasy_map FROM ordered;
  IF fantasy IS NULL THEN
    SELECT COALESCE(avg((fantasy_map->>(line->>'id'))::numeric) FILTER (WHERE NOT (line->>'did_not_play')::boolean), 0) INTO fantasy
      FROM jsonb_array_elements(lines) line;
  END IF;
  RETURN jsonb_build_object('context', context, 'player', to_jsonb(player) || jsonb_build_object('display_name', COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name)),
    'five_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1),
        'three_year_points', (SELECT ranking.points FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id
          AND ranking.source='hashtagbasketball.com/points-3' ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)),
    'availableSeasons', COALESCE((SELECT jsonb_agg(season_year ORDER BY season_year DESC) FROM (
      SELECT season_year FROM public.mv_player_season_averages WHERE player_id = player.id
      UNION SELECT public.current_season_year_et()) years), '[]'),
    'averages', CASE WHEN COALESCE((average->>'games_played')::integer, 0) > 0 THEN jsonb_build_object(
      'gamesPlayed', average->'games_played', 'avgPoints', COALESCE(NULLIF(average->'avg_points', 'null'), '0'), 'avgRebounds', COALESCE(NULLIF(average->'avg_rebounds', 'null'), '0'),
      'avgAssists', COALESCE(NULLIF(average->'avg_assists', 'null'), '0'), 'avgSteals', COALESCE(NULLIF(average->'avg_steals', 'null'), '0'), 'avgBlocks', COALESCE(NULLIF(average->'avg_blocks', 'null'), '0'),
      'avgTurnovers', COALESCE(NULLIF(average->'avg_turnovers', 'null'), '0'), 'avgThreePointersMade', COALESCE(NULLIF(average->'avg_three_pointers_made', 'null'), '0'),
      'avgFieldGoalsMade', COALESCE(NULLIF(average->'avg_field_goals_made', 'null'), '0'), 'avgFieldGoalsAttempted', COALESCE(NULLIF(average->'avg_field_goals_attempted', 'null'), '0'),
      'avgFreeThrowsMade', COALESCE(NULLIF(average->'avg_free_throws_made', 'null'), '0'), 'avgFreeThrowsAttempted', COALESCE(NULLIF(average->'avg_free_throws_attempted', 'null'), '0'),
      'avgMinutesPlayed', COALESCE(NULLIF(average->'avg_minutes_played', 'null'), '0'), 'doubleDoubles', COALESCE(NULLIF(average->'double_doubles', 'null'), '0'), 'tripleDoubles', COALESCE(NULLIF(average->'triple_doubles', 'null'), '0')) END,
    'avgFantasyPoints', fantasy, 'lines', lines, 'transactions', transactions, 'projection', projection, 'nextProjection', projection,
    'gameLog', COALESCE((SELECT jsonb_agg(game ORDER BY ordinal) FROM jsonb_array_elements(games) WITH ORDINALITY entries(game, ordinal)
      WHERE ordinal <= LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100)), '[]'),
    'hasMoreGames', jsonb_array_length(games) > LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100),
    'includesLive', EXISTS (SELECT 1 FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean),
    'liveGame', (SELECT game FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean LIMIT 1),
    'fantasyPointsMap', fantasy_map, 'selectedSeason', (context->>'seasonYear')::integer,
    'ownership', (SELECT jsonb_build_object('memberId', r.member_id, 'teamName', COALESCE(m.team_name, 'Team'), 'isOnTaxi', r.is_on_taxi) FROM public.roster_players r JOIN public.league_members m ON m.id = r.member_id WHERE r.league_id = p_league_id AND r.league_season_id = (context->>'seasonId')::uuid AND r.player_id = player.id LIMIT 1),
    'clearsAt', (SELECT max(clears_at) FROM public.waiver_wire_log WHERE league_id = p_league_id AND player_id = player.id AND cleared_at IS NULL AND clears_at > now() AND league_season_id = (context->>'seasonId')::uuid),
    'scoringSettings', context->'league'->'scoring_settings', 'roster', public.view_roster(p_league_id, p_member_id, p_params));
END;
$$;

CREATE OR REPLACE FUNCTION public.view_draft_room(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; draft public.drafts%ROWTYPE; orders jsonb; budgets jsonb; nominations jsonb; picks jsonb;
  open_nomination jsonb; active_bids jsonb; current_member uuid; prospects jsonb; search_results jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO draft FROM public.drafts WHERE id = (p_params->>'draftId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'draft', NULL); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('position', entry.position, 'memberId', entry.member_id,
    'teamName', COALESCE(member.team_name, 'Unknown')) ORDER BY entry.position), '[]') INTO orders
    FROM public.draft_orders entry LEFT JOIN public.league_members member ON member.id = entry.member_id WHERE entry.draft_id = draft.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', budget.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'remaining', budget.remaining, 'initialBudget', budget.initial_budget) ORDER BY entry.position), '[]') INTO budgets
    FROM public.draft_budgets budget LEFT JOIN public.league_members member ON member.id = budget.member_id
      LEFT JOIN public.draft_orders entry ON entry.draft_id = budget.draft_id AND entry.member_id = budget.member_id WHERE budget.draft_id = draft.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', nomination.id, 'status', nomination.status,
    'nominatingMemberId', nomination.nominating_member_id, 'currentBidAmount', nomination.current_bid_amount,
    'currentBidderId', nomination.current_bidder_id, 'currentBidToTaxi', nomination.current_bid_to_taxi,
    'countdownExpiresAt', nomination.countdown_expires_at, 'winningMemberId', nomination.winning_member_id,
    'finalPrice', nomination.final_price, 'nominatedAt', nomination.nominated_at, 'nominationOrder', nomination.nomination_order,
    'player', jsonb_build_object('displayName', COALESCE(player.display_name, 'Unknown'), 'nbaTeam', player.nba_team,
      'position', player.position, 'nbaId', player.nba_id, 'yearsExp', player.years_exp,
      'careerGames', player.career_regular_season_games, 'injuryStatus', player.injury_status,
      'age', (SELECT age FROM public.dynasty_rankings WHERE player_id = player.id AND source = 'hashtagbasketball.com' AND age IS NOT NULL ORDER BY fetched_at DESC NULLS LAST LIMIT 1)))
    ORDER BY nomination.nomination_order, nomination.id), '[]') INTO nominations
  FROM (SELECT * FROM public.nominations WHERE draft_id = draft.id ORDER BY nomination_order DESC LIMIT 500) nomination
    LEFT JOIN public.players player ON player.id = nomination.player_id;
  SELECT item INTO open_nomination FROM jsonb_array_elements(nominations) item WHERE item->>'status' = 'open' LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', bid.id, 'nominationId', bid.nomination_id, 'memberId', bid.member_id,
    'teamName', COALESCE(member.team_name, 'Unknown'), 'amount', bid.amount, 'placedAt', bid.placed_at)
    ORDER BY bid.placed_at DESC, bid.id), '[]') INTO active_bids
  FROM (SELECT * FROM public.bids WHERE nomination_id = (open_nomination->>'id')::uuid ORDER BY placed_at DESC LIMIT 100) bid
    LEFT JOIN public.league_members member ON member.id = bid.member_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('overallPick', pick.overall_pick, 'round', pick.round, 'pickInRound', pick.pick_in_round,
    'memberId', pick.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'), 'pickedAt', pick.picked_at,
    'skippedAt', pick.skipped_at, 'skipReason', pick.skip_reason, 'timerExpiresAt', pick.timer_expires_at,
    'player', CASE WHEN player.id IS NOT NULL THEN jsonb_build_object('id', player.id, 'displayName', COALESCE(player.display_name, 'Unknown'),
      'nbaTeam', player.nba_team, 'position', player.position, 'nbaId', player.nba_id, 'yearsExp', player.years_exp,
      'careerGames', player.career_regular_season_games, 'injuryStatus', player.injury_status) END) ORDER BY pick.overall_pick), '[]') INTO picks
    FROM public.snake_draft_picks pick LEFT JOIN public.league_members member ON member.id = pick.member_id
      LEFT JOIN public.players player ON player.id = pick.player_id WHERE pick.draft_id = draft.id;
  IF jsonb_array_length(orders) > 0 THEN current_member := (orders->((draft.current_nomination_order - 1) % jsonb_array_length(orders))->>'memberId')::uuid; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(player) ORDER BY player.nba_draft_number, player.id), '[]') INTO prospects
    FROM (SELECT id, display_name, nba_team, position, nba_id, injury_status, nba_draft_number, years_exp, career_regular_season_games
      FROM public.players WHERE nba_draft_number IS NOT NULL AND years_exp = 0
        AND (COALESCE(p_params->>'query', '') = '' OR display_name ILIKE '%' || (p_params->>'query') || '%')
      ORDER BY nba_draft_number, id LIMIT 100) player
    WHERE NOT EXISTS (SELECT 1 FROM public.snake_draft_picks WHERE draft_id = draft.id AND player_id = player.id);
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || jsonb_build_object('age', (SELECT age FROM public.dynasty_rankings
    WHERE player_id = player.id AND source = 'hashtagbasketball.com' AND age IS NOT NULL ORDER BY fetched_at DESC NULLS LAST LIMIT 1)) ORDER BY ordinal), '[]') INTO search_results
    FROM (SELECT p.id, p.display_name, p.nba_team, p.position, p.nba_id, p.injury_status, p.years_exp,
      p.career_regular_season_games, p.dynasty_rank, p.dynasty_rank_source, p.dynasty_rank_fetched_at,
      row_number() OVER (ORDER BY CASE WHEN draft.nomination_order_mode <> 'alphabetical' THEN p.dynasty_rank END NULLS LAST, p.last_name, p.display_name, p.id) AS ordinal
      FROM public.players p WHERE NOT EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = draft.id AND player_id = p.id)
        AND (COALESCE(p_params->>'query', '') = '' OR p.display_name ILIKE '%' || (p_params->>'query') || '%')
      ORDER BY ordinal LIMIT 20) player;
  RETURN jsonb_build_object('context', context, 'draft', jsonb_build_object('id', draft.id, 'leagueId', draft.league_id,
    'leagueSeasonId', draft.league_season_id, 'seasonYear', (SELECT season_year FROM public.league_seasons WHERE id = draft.league_season_id),
    'isCurrentSeason', COALESCE((SELECT is_current FROM public.league_seasons WHERE id = draft.league_season_id), false),
    'status', draft.status, 'draftType', draft.draft_type, 'isMock', draft.is_mock, 'currentNominationOrder', draft.current_nomination_order,
    'nominationOrderMode', draft.nomination_order_mode, 'budgetPerTeam', draft.budget_per_team, 'scheduledAt', draft.scheduled_at,
    'roomName', draft.room_name, 'createdByMemberId', draft.created_by_member_id, 'pickTimerSeconds', draft.pick_timer_seconds,
    'timerExpiryBehavior', draft.timer_expiry_behavior, 'rounds', draft.rounds, 'startedAt', draft.started_at, 'completedAt', draft.completed_at,
    'pauseReason', draft.pause_reason, 'pausedAt', draft.paused_at, 'pausedRemainingSeconds', draft.timer_paused_remaining_seconds),
    'order', orders, 'orders', orders, 'budgets', budgets, 'nominations', nominations, 'openNomination', open_nomination,
    'activeBids', active_bids, 'currentNominatorMemberId', current_member, 'picks', picks,
    'prospects', prospects, 'searchResults', search_results,
    'nextPick', (SELECT item FROM jsonb_array_elements(picks) item WHERE item->>'player' IS NULL AND item->>'skippedAt' IS NULL LIMIT 1));
END;
$$;

WITH canonical AS (
  SELECT DISTINCT ON (player_id) player_id, source_rank, fetched_at
    FROM public.dynasty_rankings
   WHERE source = 'hashtagbasketball.com' AND player_id IS NOT NULL
   ORDER BY player_id, fetched_at DESC, source_rank, id
), restored AS (
  SELECT player.id, canonical.source_rank, canonical.fetched_at
    FROM public.players player
    LEFT JOIN canonical ON canonical.player_id = player.id
   WHERE canonical.player_id IS NOT NULL
      OR player.dynasty_rank_source IN ('onenumberhoops.com', 'hashtagbasketball.com')
)
UPDATE public.players player
   SET dynasty_rank = restored.source_rank,
       dynasty_rank_source = CASE WHEN restored.source_rank IS NOT NULL THEN 'hashtagbasketball.com' END,
       dynasty_rank_fetched_at = restored.fetched_at
  FROM restored
 WHERE player.id = restored.id;

CREATE OR REPLACE FUNCTION private.trade_value_player_inputs(
  p_league_id uuid, p_member_id uuid, p_season_year integer, p_player_ids uuid[], p_limit integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || CASE WHEN market.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'dynasty_ranking_id', market.id,
    'five_year_rank', market.source_rank,
    'rank_change', market.rank_change,
    'age', market.age,
    'ranking_source', market.source,
    'ranking_fetched_at', market.fetched_at,
    'trade_value', market.trade_value
  ) END ORDER BY player.player_id), '[]'::jsonb)
  FROM public.get_dynasty_forecast_inputs(p_league_id, p_member_id, p_season_year, p_player_ids, '', p_limit, 0) player
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings ranking
     WHERE ranking.player_id = player.player_id AND ranking.source = 'onenumberhoops.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) market ON true;
$$;
REVOKE ALL ON FUNCTION private.trade_value_player_inputs(uuid,uuid,integer,uuid[],integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.build_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb,p_require_ownership boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE; terms jsonb;
  v_item jsonb; seen text[]:='{}'; identity text; player_ids uuid[]; replacement_ids uuid[];
  player_rows jsonb; replacement_rows jsonb; picks jsonb; balances jsonb; pick_values jsonb:='[]'::jsonb;
  previous_user text:=current_setting('request.jwt.claim.sub',true); teams integer;
BEGIN
  SELECT l.* INTO league FROM public.leagues l JOIN public.league_members m ON m.league_id=l.id
    WHERE m.id=p_member_id AND m.user_id=p_user_id AND l.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authorized to estimate trades for this team.' USING ERRCODE='42501'; END IF;
  SELECT * INTO season FROM public.league_seasons WHERE league_id=league.id AND is_current;
  IF NOT FOUND THEN RAISE EXCEPTION 'This league has no active season.' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'A trade estimate needs between 1 and 100 assets.' USING ERRCODE='22023';
  END IF;
  terms:=private.canonical_trade_estimate_terms(p_items);
  FOR v_item IN SELECT value FROM jsonb_array_elements(terms) LOOP
    IF v_item->>'fromMemberId' IS NULL OR v_item->>'toMemberId' IS NULL OR v_item->>'fromMemberId'=v_item->>'toMemberId'
      OR (v_item->>'playerId' IS NOT NULL)::int+(v_item->>'pickId' IS NOT NULL)::int+((v_item->>'faabAmount')::int>0)::int<>1
      OR (v_item->>'faabAmount')::int<0 THEN
      RAISE EXCEPTION 'Each estimate asset must move between two different teams.' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM public.league_members WHERE league_id=league.id
      AND id IN((v_item->>'fromMemberId')::uuid,(v_item->>'toMemberId')::uuid))<>2 THEN
      RAISE EXCEPTION 'All trade participants must belong to this league.' USING ERRCODE='42501';
    END IF;
    identity:=CASE WHEN v_item->>'playerId' IS NOT NULL THEN 'player:'||(v_item->>'playerId')
      WHEN v_item->>'pickId' IS NOT NULL THEN 'pick:'||(v_item->>'pickId')
      ELSE 'faab:'||(v_item->>'fromMemberId')||':'||(v_item->>'toMemberId') END;
    IF identity=ANY(seen) THEN RAISE EXCEPTION 'Each trade asset must appear exactly once.' USING ERRCODE='22023'; END IF;
    seen:=array_append(seen,identity);
    IF p_require_ownership AND v_item->>'playerId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.roster_players r
      WHERE r.league_id=league.id AND r.league_season_id=season.id AND r.member_id=(v_item->>'fromMemberId')::uuid
        AND r.player_id=(v_item->>'playerId')::uuid) THEN
      RAISE EXCEPTION 'A selected player is no longer owned by the sending team.' USING ERRCODE='22023';
    END IF;
    IF p_require_ownership AND v_item->>'pickId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.draft_picks p
      WHERE p.league_id=league.id AND p.current_owner_id=(v_item->>'fromMemberId')::uuid
        AND p.id=(v_item->>'pickId')::uuid AND NOT p.is_used) THEN
      RAISE EXCEPTION 'A selected pick is no longer available to the sending team.' USING ERRCODE='22023';
    END IF;
  END LOOP;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=league.id;
  SELECT COALESCE(array_agg((item->>'playerId')::uuid ORDER BY item->>'playerId'),'{}') INTO player_ids
    FROM jsonb_array_elements(terms) item WHERE item->>'playerId' IS NOT NULL;
  SELECT COALESCE(array_agg(candidate.player_id),'{}') INTO replacement_ids FROM (
    SELECT average.player_id FROM public.v_player_avg_fantasy_points average
    JOIN public.players player ON player.id=average.player_id AND player.nba_team IS NOT NULL
    WHERE average.league_id=league.id AND average.season_year=season.season_year
      AND NOT EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_id=league.id
        AND roster.league_season_id=season.id AND roster.player_id=average.player_id)
    ORDER BY average.avg_fantasy_points DESC,average.player_id LIMIT 5
  ) candidate;
  PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
  player_rows:=private.trade_value_player_inputs(league.id,p_member_id,season.season_year,player_ids,100);
  replacement_rows:=private.trade_value_player_inputs(league.id,p_member_id,season.season_year,replacement_ids,5);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(terms) item WHERE item->>'pickId' IS NOT NULL) THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(value)),'[]'::jsonb) INTO pick_values FROM public.get_dynasty_pick_values(league.id) value;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'seasonYear',pick.season_year,'round',pick.round,
    'ownerId',pick.current_owner_id,'originalOwnerId',pick.original_owner_id,'originalTeamName',member.team_name,
    'slot',slot.pick_in_round,
    'valueBands',COALESCE((SELECT jsonb_object_agg(value.tier,CASE WHEN value.tier='mid' AND slot.pick_in_round IS NULL THEN COALESCE(pick.predicted_trade_value,value.trade_value) ELSE value.trade_value END) FROM jsonb_to_recordset(pick_values) AS value(draft_year integer,round integer,tier text,trade_value numeric,fetched_at timestamptz)
      WHERE value.draft_year=pick.season_year-1 AND value.round=pick.round),CASE WHEN slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN jsonb_set(pick.predicted_value_bands,'{mid}',to_jsonb(pick.predicted_trade_value)) ELSE pick.predicted_value_bands END),
    'valueFetchedAt',(SELECT max(value.fetched_at) FROM jsonb_to_recordset(pick_values) AS value(draft_year integer,round integer,tier text,trade_value numeric,fetched_at timestamptz)
      WHERE value.draft_year=pick.season_year-1 AND value.round=pick.round)) ORDER BY pick.id),'[]'::jsonb) INTO picks
  FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
  LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
  WHERE pick.id IN(SELECT (item->>'pickId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT jsonb_agg(jsonb_build_object('memberId',member.id,'balance',COALESCE(balance.balance,league.faab_starting_budget)) ORDER BY member.id)
    INTO balances FROM public.league_members member LEFT JOIN public.faab_balances balance
    ON balance.member_id=member.id AND balance.league_season_id=season.id WHERE member.league_id=league.id
    AND member.id IN(SELECT (item->>'fromMemberId')::uuid FROM jsonb_array_elements(terms) item);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  RETURN jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,
    'teams',teams,'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'terms',terms,'players',player_rows,'replacementPlayers',replacement_rows,'picks',picks,'balances',balances);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_inputs(p_trade_id uuid,p_run text DEFAULT 'onenumber-trade-v1')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  trade public.trades%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  terms jsonb; player_ids uuid[]; replacement_ids uuid[]; players jsonb; replacements jsonb; picks jsonb;
  actor uuid; teams integer; floor_value numeric; inputs jsonb;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id;
  IF EXISTS(SELECT 1 FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version=p_run) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT league FROM public.leagues WHERE id=trade.league_id;
  SELECT * INTO season FROM public.league_seasons WHERE league_id=league.id
    ORDER BY is_current DESC,(id=trade.league_season_id) DESC,season_year DESC LIMIT 1;
  SELECT user_id INTO actor FROM public.league_members WHERE id=trade.proposer_member_id;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=league.id;
  SELECT private.canonical_trade_estimate_terms(COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount)),'[]'::jsonb))
    INTO terms FROM public.trade_items i WHERE i.trade_id=trade.id;
  SELECT COALESCE(array_agg((item->>'playerId')::uuid),'{}') INTO player_ids
    FROM jsonb_array_elements(terms) item WHERE item->>'playerId' IS NOT NULL;
  SELECT COALESCE(array_agg(candidate.player_id),'{}') INTO replacement_ids FROM (
    SELECT average.player_id FROM public.v_player_avg_fantasy_points average
    JOIN public.players player ON player.id=average.player_id AND player.nba_team IS NOT NULL
    WHERE average.league_id=league.id AND average.season_year=season.season_year
      AND NOT EXISTS(SELECT 1 FROM public.roster_players r WHERE r.league_id=league.id AND r.league_season_id=season.id AND r.player_id=average.player_id)
    ORDER BY average.avg_fantasy_points DESC,average.player_id LIMIT 5
  ) candidate;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  players:=private.trade_value_player_inputs(league.id,trade.proposer_member_id,season.season_year,player_ids,100);
  replacements:=private.trade_value_player_inputs(league.id,trade.proposer_member_id,season.season_year,replacement_ids,5);
  SELECT LEAST(500,COALESCE(avg(r.trade_value),GREATEST(50,180.0*200/GREATEST(1,teams*league.roster_size)))) INTO floor_value
    FROM public.dynasty_rankings r WHERE r.source='onenumberhoops.com' AND r.player_id=ANY(replacement_ids);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'seasonYear',pick.season_year,'round',pick.round,
    'ownerId',pick.current_owner_id,'originalOwnerId',pick.original_owner_id,'originalTeamName',member.team_name,'slot',slot.pick_in_round,
    'valueBands',COALESCE((SELECT jsonb_object_agg(v.tier,CASE WHEN v.tier='mid' AND slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN pick.predicted_trade_value WHEN v.round=3 THEN GREATEST(v.trade_value,floor_value) ELSE v.trade_value END)
      FROM public.dynasty_pick_values v WHERE v.draft_year=pick.season_year-1 AND v.round=pick.round),CASE WHEN slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN jsonb_set(pick.predicted_value_bands,'{mid}',to_jsonb(pick.predicted_trade_value)) ELSE pick.predicted_value_bands END),
    'valueFetchedAt',(SELECT max(v.fetched_at) FROM public.dynasty_pick_values v WHERE v.draft_year=pick.season_year-1 AND v.round=pick.round)) ORDER BY pick.id),'[]'::jsonb)
    INTO picks FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    WHERE pick.id IN(SELECT (item->>'pickId')::uuid FROM jsonb_array_elements(terms) item WHERE item->>'pickId' IS NOT NULL);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  inputs:=jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,'teams',teams,
    'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'terms',terms,'players',players,'replacementPlayers',replacements,'picks',picks,'revaluationTradeId',trade.id);
  RETURN inputs||jsonb_build_object('inputVersion',md5(inputs::text),'observedAt',now());
END;
$$;
