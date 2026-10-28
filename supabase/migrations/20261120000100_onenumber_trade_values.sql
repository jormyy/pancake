ALTER TABLE public.dynasty_rankings ADD COLUMN trade_value numeric CHECK(trade_value BETWEEN 0 AND 1000);
CREATE TABLE private.trade_value_sync_state(
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  request_id uuid,last_request_at timestamptz,fetched_at timestamptz,source_body text,
  content_sha256 text,mode text,matched integer
);
INSERT INTO private.trade_value_sync_state(id) VALUES(true);
ALTER TABLE private.trade_value_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.trade_value_sync_state FROM PUBLIC,anon,authenticated;
GRANT ALL ON private.trade_value_sync_state TO service_role;
CREATE TABLE public.trade_value_reviews(
  source_id text PRIMARY KEY,source_name text NOT NULL,source_team text NOT NULL,source_positions text[] NOT NULL,
  trade_value numeric NOT NULL CHECK(trade_value BETWEEN 0 AND 1000),reason text NOT NULL,candidate_ids uuid[] NOT NULL DEFAULT '{}',
  fetched_at timestamptz NOT NULL,resolved_player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,resolved_at timestamptz
);
ALTER TABLE public.trade_value_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trade_value_reviews FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.trade_value_reviews TO authenticated;
GRANT ALL ON public.trade_value_reviews TO service_role;
CREATE POLICY trade_value_reviews_read ON public.trade_value_reviews FOR SELECT TO authenticated USING(
  EXISTS(SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
    WHERE member.user_id=(SELECT auth.uid()) AND league.deleted_at IS NULL AND member.role IN('commissioner','co_commissioner'))
  OR (SELECT auth.jwt()->'app_metadata'->>'role')='admin'
);
CREATE TABLE public.dynasty_pick_values(
  draft_year integer NOT NULL,round integer NOT NULL CHECK(round BETWEEN 1 AND 3),tier text NOT NULL CHECK(tier IN('early','mid','late')),
  trade_value numeric NOT NULL CHECK(trade_value BETWEEN 0 AND 1000),derived boolean NOT NULL,
  source text NOT NULL DEFAULT 'onenumberhoops.com',fetched_at timestamptz NOT NULL,
  PRIMARY KEY(draft_year,round,tier)
);
ALTER TABLE public.dynasty_pick_values ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dynasty_pick_values FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.dynasty_pick_values TO authenticated;
GRANT ALL ON public.dynasty_pick_values TO service_role;
CREATE POLICY dynasty_pick_values_read ON public.dynasty_pick_values FOR SELECT TO authenticated USING(true);
CREATE TRIGGER work_lease_fence BEFORE INSERT OR UPDATE OR DELETE ON private.trade_value_sync_state
  FOR EACH STATEMENT EXECUTE FUNCTION private.work_enforce_lease();
CREATE TRIGGER work_lease_fence BEFORE INSERT OR UPDATE OR DELETE ON public.trade_value_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION private.work_enforce_lease();
CREATE TRIGGER work_lease_fence BEFORE INSERT OR UPDATE OR DELETE ON public.dynasty_pick_values
  FOR EACH STATEMENT EXECUTE FUNCTION private.work_enforce_lease();
INSERT INTO private.work_kinds(kind,function_name) VALUES('sync-trade-values','sync-trade-values');

CREATE OR REPLACE FUNCTION public.claim_trade_value_sync(p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE private.trade_value_sync_state SET request_id=p_request_id,last_request_at=clock_timestamp()
  WHERE id AND (last_request_at IS NULL OR (last_request_at AT TIME ZONE 'America/New_York')::date<(clock_timestamp() AT TIME ZONE 'America/New_York')::date);
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_trade_value_sync(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_trade_value_sync(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_trade_value_sync_state()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT to_jsonb(state) FROM private.trade_value_sync_state state WHERE id;
$$;
REVOKE ALL ON FUNCTION public.get_trade_value_sync_state() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_value_sync_state() TO service_role;

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
  UPDATE public.players player SET dynasty_rank=row.rank,dynasty_rank_source='onenumberhoops.com',dynasty_rank_fetched_at=p_fetched_at
    FROM pg_temp.trade_value_players row WHERE player.id=row.player_id;
  UPDATE public.players SET dynasty_rank=NULL,dynasty_rank_source=NULL,dynasty_rank_fetched_at=NULL
    WHERE dynasty_rank_source='onenumberhoops.com' AND id NOT IN(SELECT player_id FROM pg_temp.trade_value_players WHERE player_id IS NOT NULL);
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
  RETURN jsonb_build_object('players',450,'matched',v_matched,'unmatched',450-v_matched,'picks',18,'derivedPicks',9);
END;
$$;
REVOKE ALL ON FUNCTION public.publish_trade_values(jsonb,jsonb,text,timestamptz,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_trade_values(jsonb,jsonb,text,timestamptz,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trade_value_review_overrides()
RETURNS TABLE(source_id text,resolved_player_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT source_id,resolved_player_id FROM public.trade_value_reviews WHERE resolved_player_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.trade_value_review_overrides() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trade_value_review_overrides() TO service_role;

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
  UPDATE public.players player SET dynasty_rank=ranking.source_rank,dynasty_rank_source=ranking.source,
    dynasty_rank_fetched_at=ranking.fetched_at FROM public.dynasty_rankings ranking
    WHERE player.id=p_player_id AND ranking.source='onenumberhoops.com' AND ranking.source_player_id=p_source_id;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_trade_value_review(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_trade_value_review(text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_dynasty_pick_values(p_league_id uuid)
RETURNS TABLE(draft_year integer,round integer,tier text,trade_value numeric,source text,fetched_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH league AS (
    SELECT l.*,s.id AS season_id,s.season_year,
      (SELECT count(*) FROM public.league_members WHERE league_id=l.id) AS teams
    FROM public.leagues l JOIN public.league_seasons s ON s.league_id=l.id AND s.is_current
    WHERE l.id=p_league_id AND (EXISTS(SELECT 1 FROM public.league_members WHERE league_id=l.id AND user_id=auth.uid())
      OR auth.role()='service_role')
  ), replacements AS (
    SELECT ranking.trade_value FROM league
    JOIN public.v_player_avg_fantasy_points average ON average.league_id=league.id AND average.season_year=league.season_year
    JOIN public.dynasty_rankings ranking ON ranking.player_id=average.player_id AND ranking.source='onenumberhoops.com'
    WHERE ranking.trade_value IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.roster_players roster
      WHERE roster.league_id=league.id AND roster.league_season_id=league.season_id AND roster.player_id=average.player_id)
    ORDER BY average.avg_fantasy_points DESC,average.player_id LIMIT 5
  ), floor AS (
    SELECT LEAST(500,COALESCE((SELECT avg(trade_value) FROM replacements),
      GREATEST(50,180.0*200/GREATEST(1,teams*roster_size)))) AS value FROM league
  )
  SELECT pick.draft_year,pick.round,pick.tier,CASE WHEN pick.round=3 THEN GREATEST(pick.trade_value,floor.value)
    ELSE pick.trade_value END,pick.source,pick.fetched_at
  FROM public.dynasty_pick_values pick CROSS JOIN floor ORDER BY pick.draft_year,pick.round,pick.tier;
$$;
REVOKE ALL ON FUNCTION public.get_dynasty_pick_values(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_dynasty_pick_values(uuid) TO authenticated,service_role;

DROP FUNCTION public.get_dynasty_forecast_inputs(uuid,uuid,integer,uuid[],text,integer,integer);

-- Canonical SQL source for public.get_dynasty_forecast_inputs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
        'onenumberhoops.com',
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
       AND ranking.source IN ('onenumberhoops.com','hashtagbasketball.com')
     ORDER BY (ranking.source='onenumberhoops.com') DESC, ranking.fetched_at DESC, ranking.source_rank, ranking.id
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
  'Returns authorized dynasty ranks, market values, production, and projections.';

CREATE OR REPLACE FUNCTION private.enqueue_scheduled_work(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_min integer:=extract(minute FROM p_now AT TIME ZONE 'UTC')::int;
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
    PERFORM private.enqueue_daily('process-waivers',3,0,p_now);
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
  IF v_min=0 THEN PERFORM private.enqueue_rankings(p_now); END IF;
  IF v_min%5=0 AND EXISTS(SELECT 1 FROM public.edge_invocations
    WHERE reconciled_at IS NULL OR worker_status='running') THEN
    PERFORM private.work_enqueue('edge-invocation-reconcile',v_key,p_now);
  END IF;
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

CREATE OR REPLACE FUNCTION private.build_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb,p_require_ownership boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE; terms jsonb;
  v_item jsonb; seen text[]:='{}'; identity text; player_ids uuid[]; replacement_ids uuid[];
  player_rows jsonb; replacement_rows jsonb; picks jsonb; balances jsonb;
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
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.player_id),'[]'::jsonb) INTO player_rows
    FROM public.get_dynasty_forecast_inputs(league.id,p_member_id,season.season_year,player_ids,'',100,0) p;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.player_id),'[]'::jsonb) INTO replacement_rows
    FROM public.get_dynasty_forecast_inputs(league.id,p_member_id,season.season_year,replacement_ids,'',5,0) p;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'seasonYear',pick.season_year,'round',pick.round,
    'ownerId',pick.current_owner_id,'originalOwnerId',pick.original_owner_id,'originalTeamName',member.team_name,
    'slot',slot.pick_in_round,
    'valueBands',(SELECT jsonb_object_agg(value.tier,value.trade_value) FROM public.get_dynasty_pick_values(league.id) value
      WHERE value.draft_year=pick.season_year-1 AND value.round=pick.round),
    'valueFetchedAt',(SELECT max(value.fetched_at) FROM public.get_dynasty_pick_values(league.id) value
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
