BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='120s';

CREATE TABLE private.trade_input_revisions(
  source text NOT NULL,
  scope text NOT NULL DEFAULT '',
  writer integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(scope,source,writer)
);
REVOKE ALL ON private.trade_input_revisions FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE private.trade_revaluation_schedule(
  trade_id uuid NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  model_version text NOT NULL,
  next_allowed_at timestamptz NOT NULL,
  PRIMARY KEY(trade_id)
);
REVOKE ALL ON private.trade_revaluation_schedule FROM PUBLIC,anon,authenticated,service_role;

CREATE INDEX idx_pgs_trade_game_player ON public.player_game_stats(game_id,player_id) WHERE NOT did_not_play;
CREATE INDEX idx_trade_ranking_fetched ON public.dynasty_rankings(fetched_at);
CREATE INDEX idx_trade_fantasypros_fetched ON public.fantasypros_projection_rows(fetched_at);
CREATE INDEX idx_trade_sleeper_fetched ON public.sleeper_projection_rows(fetched_at);
CREATE INDEX idx_trade_projection_fetched ON public.player_projections(fetched_at);
CREATE INDEX idx_trade_game_time ON public.nba_games(game_time);
CREATE INDEX idx_trade_game_started ON public.nba_games(started_at);

CREATE OR REPLACE FUNCTION private.compact_trade_input_revisions()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT count(*) FROM (SELECT 1 FROM private.trade_input_revisions r WHERE writer<>0
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=r.writer) LIMIT 64) retired)<64
    OR NOT pg_try_advisory_xact_lock(hashtextextended('trade-input-compaction',0)) THEN RETURN; END IF;
  WITH retired AS (
    DELETE FROM private.trade_input_revisions r WHERE writer<>0
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=r.writer)
    RETURNING source,scope,revision
  )
  INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
    SELECT source,scope,0,sum(revision)::bigint FROM retired GROUP BY source,scope
    ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+EXCLUDED.revision;
END;
$$;
REVOKE ALL ON FUNCTION private.compact_trade_input_revisions() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.track_trade_input_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed boolean; scope_query text; selected_scope text; columns text:=TG_ARGV[0]; local_revision text;
BEGIN
  IF TG_LEVEL='ROW' THEN
    IF TG_TABLE_NAME='players' THEN
      local_revision:=NULLIF(current_setting('pancake.trade_player_revision',true),'');
      PERFORM set_config('pancake.trade_player_revision',(COALESCE(local_revision::bigint,0)+1)::text,true);
      IF local_revision IS NOT NULL THEN RETURN NULL; END IF;
    END IF;
    INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
      VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,'',pg_backend_pid(),1)
      ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+1;
    RETURN NULL;
  END IF;
  IF TG_TABLE_SCHEMA='analytics' AND pg_trigger_depth()>1 THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN
    changed:=false;
    IF TG_TABLE_NAME IN ('player_projections','fantasypros_projection_rows','sleeper_projection_rows') THEN
      SELECT (SELECT max(fetched_at) FROM trade_new) IS DISTINCT FROM (SELECT max(fetched_at) FROM trade_old) INTO changed;
    END IF;
    IF NOT changed THEN
      IF TG_TABLE_NAME='players' THEN
        SELECT EXISTS(SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_new EXCEPT SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_old)
          OR EXISTS(SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_old EXCEPT SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_new) INTO changed;
      ELSIF TG_TABLE_NAME='player_game_stats' THEN
        SELECT EXISTS(SELECT id,game_id,player_id,season_year,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play FROM trade_new EXCEPT SELECT id,game_id,player_id,season_year,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play FROM trade_old) INTO changed;
      ELSIF TG_TABLE_NAME='player_projections' THEN
        SELECT EXISTS(SELECT id,player_id,season_year,week_number,projected_stat_points,projected_rebounds,projected_assists,projected_steals,projected_blocks,projected_three_pointers_made,projected_turnovers,projected_field_goals_made,projected_field_goals_attempted,projected_free_throws_made,projected_free_throws_attempted,projected_double_doubles,projected_triple_doubles,fetched_at FROM trade_new EXCEPT SELECT id,player_id,season_year,week_number,projected_stat_points,projected_rebounds,projected_assists,projected_steals,projected_blocks,projected_three_pointers_made,projected_turnovers,projected_field_goals_made,projected_field_goals_attempted,projected_free_throws_made,projected_free_throws_attempted,projected_double_doubles,projected_triple_doubles,fetched_at FROM trade_old) INTO changed;
      ELSE
        EXECUTE format('SELECT EXISTS(SELECT %s FROM trade_new EXCEPT SELECT %s FROM trade_old) OR EXISTS(SELECT %s FROM trade_old EXCEPT SELECT %s FROM trade_new)',
          columns,columns,columns,columns) INTO changed;
      END IF;
    END IF;
    IF NOT changed THEN RETURN NULL; END IF;
  ELSIF TG_OP<>'TRUNCATE' THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',CASE WHEN TG_OP='DELETE' THEN 'trade_old' ELSE 'trade_new' END) INTO changed;
    IF NOT changed THEN RETURN NULL; END IF;
  END IF;
  IF TG_NARGS<2 OR TG_OP='TRUNCATE' THEN
    INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
      VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,'',pg_backend_pid(),1)
      ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+1;
    RETURN NULL;
  ELSE
    scope_query:=CASE WHEN TG_OP<>'INSERT' THEN format('SELECT %I::text FROM trade_old',TG_ARGV[1]) ELSE '' END
      ||CASE WHEN TG_OP='UPDATE' THEN ' UNION ' ELSE '' END
      ||CASE WHEN TG_OP<>'DELETE' THEN format('SELECT %I::text FROM trade_new',TG_ARGV[1]) ELSE '' END;
  END IF;
  FOR selected_scope IN EXECUTE 'SELECT DISTINCT scope FROM ('||scope_query||') AS affected(scope) ORDER BY scope' LOOP
    INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
      VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,selected_scope,pg_backend_pid(),1)
      ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+1;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.track_trade_input_revision() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.trade_value_fantasy_averages(p_league_id uuid,p_season_year integer,p_player_ids uuid[] DEFAULT NULL)
RETURNS TABLE(player_id uuid,avg_fantasy_points numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE weights record; rounded_players uuid[]; game_ids uuid[];
BEGIN
  SELECT COALESCE((scoring_settings->>'points')::numeric,0) AS points,
    COALESCE((scoring_settings->>'rebounds')::numeric,0) AS rebounds,
    COALESCE((scoring_settings->>'assists')::numeric,0) AS assists,
    COALESCE((scoring_settings->>'steals')::numeric,0) AS steals,
    COALESCE((scoring_settings->>'blocks')::numeric,0) AS blocks,
    COALESCE((scoring_settings->>'turnovers')::numeric,0) AS turnovers,
    COALESCE((scoring_settings->>'three_pointers_made')::numeric,0) AS three_pointers_made,
    COALESCE((scoring_settings->>'field_goals_made')::numeric,0) AS field_goals_made,
    COALESCE((scoring_settings->>'field_goals_attempted')::numeric,0) AS field_goals_attempted,
    COALESCE((scoring_settings->>'free_throws_made')::numeric,0) AS free_throws_made,
    COALESCE((scoring_settings->>'free_throws_attempted')::numeric,0) AS free_throws_attempted,
    scoring_settings->>'double_double' AS double_double,scoring_settings->>'triple_double' AS triple_double
    INTO weights FROM public.leagues WHERE id=p_league_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT array_agg(totals.player_id) INTO rounded_players FROM analytics.player_season_totals totals
    WHERE totals.season_year=p_season_year AND (p_player_ids IS NULL OR totals.player_id=ANY(p_player_ids))
      AND (weights.points<>round(weights.points,2) OR
      weights.rebounds<>round(weights.rebounds,2) OR
      weights.assists<>round(weights.assists,2) OR
      weights.steals<>round(weights.steals,2) OR
      weights.blocks<>round(weights.blocks,2) OR
      weights.turnovers<>round(weights.turnovers,2) OR
      weights.three_pointers_made<>round(weights.three_pointers_made,2) OR
      weights.field_goals_made<>round(weights.field_goals_made,2) OR
      weights.field_goals_attempted<>round(weights.field_goals_attempted,2) OR
      weights.free_throws_made<>round(weights.free_throws_made,2) OR
      weights.free_throws_attempted<>round(weights.free_throws_attempted,2) OR
      (totals.double_double>0 AND COALESCE(weights.double_double::numeric,0)<>round(COALESCE(weights.double_double::numeric,0),2)) OR
      (totals.triple_double>0 AND COALESCE(weights.triple_double::numeric,0)<>round(COALESCE(weights.triple_double::numeric,0),2)));
  IF rounded_players IS NOT NULL THEN
    SELECT array_agg(game.id) INTO game_ids FROM public.nba_games game
      WHERE game.season_year=p_season_year AND public.is_regular_season_game_id(game.nba_game_id);
  END IF;
  RETURN QUERY
  WITH rounded AS MATERIALIZED (
    SELECT stats.player_id,round(avg(round(COALESCE(stats.points*weights.points,0) +
        COALESCE(stats.rebounds*weights.rebounds,0) +
        COALESCE(stats.assists*weights.assists,0) +
        COALESCE(stats.steals*weights.steals,0) +
        COALESCE(stats.blocks*weights.blocks,0) +
        COALESCE(stats.turnovers*weights.turnovers,0) +
        COALESCE(stats.three_pointers_made*weights.three_pointers_made,0) +
        COALESCE(stats.field_goals_made*weights.field_goals_made,0) +
        COALESCE(stats.field_goals_attempted*weights.field_goals_attempted,0) +
        COALESCE(stats.free_throws_made*weights.free_throws_made,0) +
        COALESCE(stats.free_throws_attempted*weights.free_throws_attempted,0) +
        CASE WHEN stats.double_double THEN COALESCE(weights.double_double::numeric,0) ELSE 0 END +
        CASE WHEN stats.triple_double THEN COALESCE(weights.triple_double::numeric,0) ELSE 0 END,2)),2) AS average
    FROM unnest(game_ids) AS game(id)
    CROSS JOIN LATERAL (
      SELECT stats.* FROM public.player_game_stats stats
      WHERE stats.game_id=game.id AND stats.player_id=ANY(rounded_players)
        AND stats.season_year=p_season_year AND NOT stats.did_not_play
      OFFSET 0
    ) stats
    GROUP BY stats.player_id
  )
  SELECT totals.player_id,CASE WHEN totals.player_id=ANY(rounded_players) THEN rounded.average
    ELSE round((totals.points*weights.points +
      totals.rebounds*weights.rebounds +
      totals.assists*weights.assists +
      totals.steals*weights.steals +
      totals.blocks*weights.blocks +
      totals.turnovers*weights.turnovers +
      totals.three_pointers_made*weights.three_pointers_made +
      totals.field_goals_made*weights.field_goals_made +
      totals.field_goals_attempted*weights.field_goals_attempted +
      totals.free_throws_made*weights.free_throws_made +
      totals.free_throws_attempted*weights.free_throws_attempted +
      CASE WHEN totals.double_double>0 THEN totals.double_double*COALESCE(weights.double_double::numeric,0) ELSE 0 END +
      CASE WHEN totals.triple_double>0 THEN totals.triple_double*COALESCE(weights.triple_double::numeric,0) ELSE 0 END)/NULLIF(totals.games_played,0),2) END
    FROM analytics.player_season_totals totals LEFT JOIN rounded ON rounded.player_id=totals.player_id
    WHERE totals.season_year=p_season_year AND (p_player_ids IS NULL OR totals.player_id=ANY(p_player_ids));
END;
$$;
REVOKE ALL ON FUNCTION private.trade_value_fantasy_averages(uuid,integer,uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.trade_revaluation_input_version(p_trade_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH context AS MATERIALIZED (
    SELECT trade.id,league.id AS league_id,season.id AS season_id,season.season_year,
      league.roster_size,league.scoring_settings,league.faab_starting_budget,
      (SELECT count(*) FROM public.league_members member WHERE member.league_id=league.id) AS teams,
      queued.averages_initialized
    FROM public.trades trade JOIN public.leagues league ON league.id=trade.league_id AND league.deleted_at IS NULL
    JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
    LEFT JOIN private.screen_refresh_queue queued ON queued.league_season_id=season.id
    WHERE trade.id=p_trade_id AND trade.status IN ('pending','accepted')
  ), assets AS MATERIALIZED (
    SELECT item.* FROM public.trade_items item WHERE item.trade_id=p_trade_id
  )
  SELECT md5(jsonb_build_array('trade-inputs-v2',to_jsonb(context),
    (SELECT jsonb_agg(jsonb_build_array(source,scope,revision) ORDER BY source,scope) FROM (
      SELECT source,scope,sum(revision)+CASE WHEN source='public.players' AND scope=''
        THEN GREATEST(COALESCE(NULLIF(current_setting('pancake.trade_player_revision',true),'')::bigint,0)-1,0) ELSE 0 END AS revision
      FROM private.trade_input_revisions
      WHERE scope IN ('',context.league_id::text,context.season_id::text) GROUP BY source,scope) versions),
    (SELECT jsonb_agg(jsonb_build_array(from_member_id,to_member_id,player_id,pick_id,faab_amount) ORDER BY id) FROM assets),
    (SELECT jsonb_agg(jsonb_build_array(pick.id,pick.season_year,pick.round,pick.current_owner_id,pick.original_owner_id,
      member.team_name,slot.pick_in_round,pick.predicted_trade_value,pick.predicted_value_bands,
      pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
      LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
      WHERE pick.id IN(SELECT pick_id FROM assets)),
    (SELECT jsonb_agg(jsonb_build_array(member.id,COALESCE(balance.balance,context.faab_starting_budget)) ORDER BY member.id)
      FROM public.league_members member LEFT JOIN public.faab_balances balance
        ON balance.member_id=member.id AND balance.league_season_id=context.season_id
      WHERE member.league_id=context.league_id AND member.id IN(SELECT from_member_id FROM assets)),
    (now() AT TIME ZONE 'America/New_York')::date,
    (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<now()-interval '90 days'),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '36 hours'),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '8 days'),
    (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<now()-interval '36 hours'),
    (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<now()-interval '8 days'),
    (SELECT max(game_time) FROM public.nba_games WHERE game_time<=now()),
    (SELECT max(started_at) FROM public.nba_games WHERE started_at<=now())
  )::text) FROM context;
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_input_version(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.trade_value_player_inputs(
  p_league_id uuid, p_member_id uuid, p_season_year integer, p_player_ids uuid[], p_limit integer
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH input_rows AS (
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
  WHERE true
     OR player.display_name ILIKE '%' || trim('') || '%'
  ORDER BY candidate.sort_rank NULLS LAST, player.display_name, player.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 600), 1), 1000)
  OFFSET GREATEST(COALESCE(0, 0), 0)
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
),
fantasy_averages AS MATERIALIZED (
  SELECT player_id, avg_fantasy_points
    FROM private.trade_value_fantasy_averages(p_league_id,p_season_year,p_player_ids)
)
SELECT
  player.id AS player_id,
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
LEFT JOIN fantasy_averages AS fantasy
  ON fantasy.player_id = player.id
LEFT JOIN projections AS projection ON projection.player_id = player.id
ORDER BY player.five_year_rank NULLS LAST, player.display_name, player.id
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(player) || CASE WHEN market.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'dynasty_ranking_id', market.id,
    'five_year_rank', market.source_rank,
    'rank_change', market.rank_change,
    'age', market.age,
    'ranking_source', market.source,
    'ranking_fetched_at', market.fetched_at,
    'trade_value', market.trade_value
  ) END ORDER BY player.player_id), '[]'::jsonb)
  FROM input_rows player
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
  player_rows jsonb; replacement_rows jsonb; player_input_rows jsonb; picks jsonb; balances jsonb; pick_values jsonb:='[]'::jsonb;
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
    SELECT average.player_id FROM (
      SELECT player_id,league_id,season_year,avg_fantasy_points FROM public.player_season_averages
        WHERE league_id=league.id AND season_year=season.season_year AND EXISTS(
          SELECT 1 FROM private.screen_refresh_queue WHERE league_season_id=season.id AND averages_initialized)
      UNION ALL
      SELECT player_id,league.id,season.season_year,avg_fantasy_points
        FROM private.trade_value_fantasy_averages(league.id,season.season_year) WHERE NOT EXISTS(
          SELECT 1 FROM private.screen_refresh_queue WHERE league_season_id=season.id AND averages_initialized)
    ) average
    JOIN public.players player ON player.id=average.player_id AND player.nba_team IS NOT NULL
    WHERE average.league_id=league.id AND average.season_year=season.season_year
      AND NOT EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_id=league.id
        AND roster.league_season_id=season.id AND roster.player_id=average.player_id)
    ORDER BY average.avg_fantasy_points DESC,average.player_id LIMIT 5
  ) candidate;
  PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
  IF cardinality(player_ids||replacement_ids)>0 THEN
    player_input_rows:=private.trade_value_player_inputs(league.id,p_member_id,season.season_year,
      ARRAY(SELECT DISTINCT id FROM unnest(player_ids||replacement_ids) id ORDER BY id),105);
  ELSE
    player_input_rows:='[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(player ORDER BY player->>'player_id'),'[]'::jsonb) INTO player_rows
    FROM jsonb_array_elements(player_input_rows) player WHERE (player->>'player_id')::uuid=ANY(player_ids);
  SELECT COALESCE(jsonb_agg(player ORDER BY player->>'player_id'),'[]'::jsonb) INTO replacement_rows
    FROM jsonb_array_elements(player_input_rows) player WHERE (player->>'player_id')::uuid=ANY(replacement_ids);
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

CREATE OR REPLACE FUNCTION public.get_dynasty_pick_values(p_league_id uuid)
RETURNS TABLE(draft_year integer,round integer,tier text,trade_value numeric,source text,fetched_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH league AS (
    SELECT l.*,s.id AS season_id,s.season_year,
      (SELECT count(*) FROM public.league_members WHERE league_id=l.id) AS teams
    FROM public.leagues l JOIN public.league_seasons s ON s.league_id=l.id AND s.is_current
    WHERE l.id=p_league_id AND (EXISTS(SELECT 1 FROM public.league_members WHERE league_id=l.id AND user_id=auth.uid())
      OR auth.role()='service_role')
  ), available AS MATERIALIZED (
    SELECT average.player_id,average.avg_fantasy_points FROM league
    CROSS JOIN LATERAL private.trade_value_fantasy_averages(league.id,league.season_year) average
    WHERE NOT EXISTS(SELECT 1 FROM public.roster_players roster
      WHERE roster.league_id=league.id AND roster.league_season_id=league.season_id AND roster.player_id=average.player_id)
  ), replacements AS (
    SELECT ranking.trade_value FROM available
    JOIN public.dynasty_rankings ranking ON ranking.player_id=available.player_id AND ranking.source='onenumberhoops.com'
    WHERE ranking.trade_value IS NOT NULL
    ORDER BY available.avg_fantasy_points DESC,available.player_id LIMIT 5
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

CREATE OR REPLACE FUNCTION public.get_trade_revaluation_inputs(p_user_id uuid,p_member_id uuid,p_trade_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  terms jsonb; inputs jsonb; fingerprint text;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
  allowed boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.trades t JOIN public.league_members m ON m.league_id=t.league_id
    JOIN public.leagues l ON l.id=t.league_id AND l.deleted_at IS NULL
    WHERE t.id=p_trade_id AND m.id=p_member_id AND m.user_id=p_user_id) THEN
    RAISE EXCEPTION 'This trade is not available for revaluation.' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',p_user_id::text,true);
  allowed:=private.can_read_trade(p_trade_id);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  IF NOT allowed THEN
    RAISE EXCEPTION 'This trade is not available for revaluation.' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.trades WHERE id=p_trade_id AND status IN ('pending','accepted')) THEN
    RETURN jsonb_build_object('closed',true,'revaluationTradeId',p_trade_id,'cachedRevaluation',
      (SELECT revaluation FROM public.trade_value_cache WHERE trade_id=p_trade_id));
  END IF;
  fingerprint:=private.trade_revaluation_input_version(p_trade_id);
  SELECT jsonb_agg(jsonb_build_object('fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,
    'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount) ORDER BY i.id)
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  inputs:=private.build_trade_estimate_inputs(p_user_id,p_member_id,terms,false)
    ||jsonb_build_object('revaluationTradeId',p_trade_id,'pickPredictionVersions',(
      SELECT jsonb_agg(jsonb_build_array(pick.id,pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.trade_items item ON item.pick_id=pick.id WHERE item.trade_id=p_trade_id));
  inputs:=inputs||jsonb_build_object('valuationFreshness',(
    SELECT jsonb_agg(jsonb_build_array(player->>'player_id',
      (player->>'ranking_fetched_at')::timestamptz BETWEEN now()-interval '90 days' AND now(),
      player->>'projection_source'='season_avg' OR (player->>'projection_fetched_at')::timestamptz
        BETWEEN now()-CASE WHEN player->>'projection_source'='internal' THEN interval '8 days' ELSE interval '36 hours' END AND now())
      ORDER BY player->>'player_id')
    FROM jsonb_array_elements((inputs->'players')||(inputs->'replacementPlayers')) player));
  IF fingerprint IS DISTINCT FROM private.trade_revaluation_input_version(p_trade_id) THEN
    RAISE EXCEPTION 'Trade inputs changed. Retry.' USING ERRCODE='40001';
  END IF;
  RETURN inputs||jsonb_build_object('inputVersion',fingerprint,'observedAt',now(),'cachedRevaluation',
    (SELECT cached.revaluation FROM private.trade_value_publications published
      JOIN public.trade_value_cache cached USING(trade_id)
      WHERE published.trade_id=p_trade_id AND published.input_fingerprint=fingerprint));
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_trade_values(p_league_id uuid, p_season_id uuid, p_version bigint, p_values jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE item jsonb; trade record; inputs jsonb; value jsonb; published boolean:=false;
BEGIN
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Trade values must be an array.' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_values) LOOP
    SELECT t.*,m.user_id INTO trade FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
      WHERE t.id=(item->>'tradeId')::uuid AND t.league_id=p_league_id AND t.league_season_id=p_season_id
        AND t.status IN ('pending','accepted') FOR UPDATE OF t;
    IF NOT FOUND THEN CONTINUE; END IF;
    value:=item->'revaluation';
    IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'inputVersion' IS NULL
      OR value->>'modelVersion' IS NULL THEN CONTINUE; END IF;
    inputs:=jsonb_build_object('inputVersion',private.trade_revaluation_input_version(trade.id));
    IF inputs->>'inputVersion' IS DISTINCT FROM value->>'inputVersion' THEN
      PERFORM private.refresh_queue_trade_revaluation(trade.id,inputs->>'inputVersion',value->>'modelVersion');
      CONTINUE;
    END IF;
    IF EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id
      AND input_fingerprint=value->>'inputVersion' AND model_version=value->>'modelVersion') THEN
      published:=true;
      CONTINUE;
    END IF;
    INSERT INTO public.trade_value_cache AS cached(trade_id,league_id,league_season_id,revaluation,valid_until,version)
      VALUES(trade.id,p_league_id,p_season_id,value,'infinity',p_version)
      ON CONFLICT(trade_id) DO UPDATE SET revaluation=EXCLUDED.revaluation,valid_until=EXCLUDED.valid_until,
        version=EXCLUDED.version,refreshed_at=now();
    INSERT INTO private.trade_value_publications(trade_id,version,valid_until,input_fingerprint,model_version)
      VALUES(trade.id,p_version,'infinity',value->>'inputVersion',value->>'modelVersion')
      ON CONFLICT(trade_id) DO UPDATE SET version=EXCLUDED.version,valid_until=EXCLUDED.valid_until,
        input_fingerprint=EXCLUDED.input_fingerprint,model_version=EXCLUDED.model_version;
    published:=true;
  END LOOP;
  RETURN published;
END;
$$;

CREATE OR REPLACE FUNCTION private.trade_revaluation_is_live(p_trade_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM public.trades trade
    JOIN public.league_seasons season ON season.league_id=trade.league_id AND season.is_current
    JOIN public.nba_games game ON game.season_year=season.season_year AND game.status='InProgress'
    WHERE trade.id=p_trade_id AND trade.status IN ('pending','accepted'));
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_is_live(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.begin_trade_revaluation(p_trade_id uuid,p_model text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE live boolean; allowed boolean;
BEGIN
  IF p_model IS NULL OR NOT EXISTS(SELECT 1 FROM public.trades WHERE id=p_trade_id AND status IN ('pending','accepted')) THEN RETURN false; END IF;
  live:=private.trade_revaluation_is_live(p_trade_id);
  INSERT INTO private.trade_revaluation_schedule AS schedule(trade_id,model_version,next_allowed_at)
    VALUES(p_trade_id,p_model,now()+CASE WHEN live THEN interval '10 minutes' ELSE interval '0' END)
    ON CONFLICT(trade_id) DO UPDATE SET next_allowed_at=EXCLUDED.next_allowed_at,model_version=EXCLUDED.model_version
    WHERE NOT live OR schedule.next_allowed_at<=now() RETURNING true INTO allowed;
  RETURN COALESCE(allowed,false);
END;
$$;
REVOKE ALL ON FUNCTION private.begin_trade_revaluation(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluation(p_trade_id uuid,p_fingerprint text,p_model text,p_inputs jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade record; work_key text; work_payload jsonb; existing private.work_items%ROWTYPE; due timestamptz; queued_id bigint;
BEGIN
  SELECT t.*,m.user_id,q.version AS screen_version INTO trade FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
    JOIN private.screen_refresh_queue q ON q.league_season_id=t.league_season_id
    WHERE t.id=p_trade_id AND t.status IN ('pending','accepted');
  IF NOT FOUND OR p_fingerprint IS NULL OR p_model IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM private.trade_value_publications WHERE trade_id=trade.id
    AND input_fingerprint=p_fingerprint AND model_version=p_model) THEN
    UPDATE private.trade_value_publications SET version=GREATEST(version,trade.screen_version),valid_until='infinity'
      WHERE trade_id=trade.id AND version<trade.screen_version;
    RETURN false;
  END IF;
  due:=now();
  IF private.trade_revaluation_is_live(trade.id) THEN
    SELECT GREATEST(now(),next_allowed_at) INTO due FROM private.trade_revaluation_schedule
      WHERE trade_id=trade.id;
    due:=COALESCE(due,now());
  END IF;
  work_key:=trade.id::text||':'||p_model||':latest';
  work_payload:=jsonb_build_object('tradeId',trade.id,'memberId',trade.proposer_member_id,'userId',trade.user_id,
    'inputFingerprint',p_fingerprint,'modelVersion',p_model,'latestInputs',true);
  SELECT * INTO existing FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    IF existing.status='running' THEN RETURN false; END IF;
    UPDATE private.work_items SET status='pending',attempts=CASE WHEN existing.status IN ('succeeded','dead') THEN 0 ELSE attempts END,
      due_at=CASE WHEN existing.status IN ('pending','failed') THEN LEAST(existing.due_at,due) ELSE due END,
      completed_at=NULL,payload=work_payload,last_error=NULL,invocation_key=NULL
      WHERE id=existing.id;
    RETURN true;
  END IF;
  IF EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation' AND key=work_key) THEN RETURN false; END IF;
  INSERT INTO private.work_items(kind,key,due_at,payload,league_id)
    VALUES('trade-revaluation',work_key,due,work_payload,trade.league_id) ON CONFLICT DO NOTHING RETURNING id INTO queued_id;
  RETURN queued_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
  IF p_params->>'operation'='begin-trade' THEN
    RETURN to_jsonb(private.begin_trade_revaluation((p_params->>'tradeId')::uuid,p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='check-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      private.trade_revaluation_input_version((p_params->>'tradeId')::uuid),p_params->>'modelVersion'));
  END IF;
  IF p_params->>'operation'='trade-ready' THEN
    RETURN to_jsonb(EXISTS(SELECT 1 FROM public.trades trade WHERE trade.id=(p_params->>'tradeId')::uuid
      AND trade.status IN ('pending','accepted') AND NOT EXISTS(SELECT 1 FROM private.trade_value_publications published
        WHERE published.trade_id=trade.id AND published.input_fingerprint=p_params->>'inputFingerprint'
          AND published.model_version=p_params->>'modelVersion')));
  END IF;
  IF p_params->>'operation'='queue-trade' THEN
    RETURN to_jsonb(private.refresh_queue_trade_revaluation((p_params->>'tradeId')::uuid,
      p_params->>'inputFingerprint',p_params->>'modelVersion',p_params->'inputs'));
  END IF;
  IF p_params->>'operation'='queue-trades' THEN
    RETURN private.refresh_queue_trade_revaluations((p_params->>'seasonId')::uuid,
      (p_params->>'version')::bigint,p_params->>'modelVersion',(p_params->>'after')::uuid);
  END IF;
  IF p_params->>'operation'='publish-trade' THEN
    RETURN to_jsonb(private.refresh_trade_values(p_league_id,(p_params->>'seasonId')::uuid,
      (SELECT version FROM private.screen_refresh_queue WHERE league_season_id=(p_params->>'seasonId')::uuid),
      jsonb_build_array(jsonb_build_object('tradeId',p_params->>'tradeId','revaluation',p_params->'revaluation'))));
  END IF;
  IF COALESCE(p_params->>'operation', 'claim') = 'claim' THEN
    WITH candidates AS (
      SELECT league_season_id FROM private.screen_refresh_queue WHERE dirty AND available_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '3 minutes')
      ORDER BY changed_at, league_season_id LIMIT LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 1), 1), 1)
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE private.screen_refresh_queue q SET claimed_at = now(), claim_token = gen_random_uuid(), claimed_version = q.version
      FROM candidates c WHERE q.league_season_id = c.league_season_id RETURNING q.*
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('leagueId', c.league_id, 'seasonId', c.league_season_id,
      'version', c.version, 'claimToken', c.claim_token)), '[]'::jsonb) INTO result FROM claimed c;
    RETURN result;
  END IF;
  SELECT * INTO queued FROM private.screen_refresh_queue WHERE league_id = p_league_id
    AND league_season_id = (p_params->>'seasonId')::uuid FOR UPDATE;
  IF NOT FOUND OR queued.claim_token IS NULL OR queued.claim_token IS DISTINCT FROM (p_params->>'claimToken')::uuid
    OR queued.claimed_version IS DISTINCT FROM (p_params->>'version')::bigint THEN RETURN 'false'; END IF;
  IF p_params->>'operation' = 'fail' THEN
    UPDATE private.screen_refresh_queue SET claim_token = NULL, claimed_at = NULL, claimed_version = NULL,
      available_at = now() + interval '1 minute', last_error = left(p_params->>'error', 1000) WHERE league_season_id = queued.league_season_id;
    RETURN 'true';
  END IF;
  IF p_params->>'operation' IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'Unknown refresh operation.' USING ERRCODE = '22023'; END IF;
  completed := queued.version = queued.claimed_version;
  IF completed THEN
    PERFORM private.refresh_standings(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_matchup_totals(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.refresh_player_averages(queued.league_id, queued.league_season_id, queued.version);
    PERFORM private.work_enqueue('trade-revaluation-scan',queued.league_season_id::text||':'||queued.version::text,now(),
      jsonb_build_object('revaluationScan',true,'leagueId',queued.league_id,'seasonId',queued.league_season_id,'version',queued.version),queued.league_id);
  END IF;
  UPDATE private.screen_refresh_queue SET dirty = NOT completed, claim_token = NULL, claimed_at = NULL,
    claimed_version = NULL, last_error = NULL, available_at = CASE WHEN completed THEN available_at ELSE now() + interval '5 seconds' END WHERE league_season_id = queued.league_season_id;
  RETURN to_jsonb(completed);
END;
$$;

DO $$
DECLARE target record; arguments text; event_name text; transition text;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('public.players','id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id',NULL),
    ('public.dynasty_rankings','*',NULL),
    ('public.player_game_stats','id,game_id,player_id,season_year,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play',NULL),
    ('analytics.player_season_totals','*',NULL),
    ('public.player_projections','id,player_id,season_year,week_number,projected_stat_points,projected_rebounds,projected_assists,projected_steals,projected_blocks,projected_three_pointers_made,projected_turnovers,projected_field_goals_made,projected_field_goals_attempted,projected_free_throws_made,projected_free_throws_attempted,projected_double_doubles,projected_triple_doubles,fetched_at',NULL),
    ('public.fantasypros_projection_rows','*',NULL),
    ('public.sleeper_projection_rows','*',NULL),
    ('public.projection_sync_runs','*',NULL),
    ('public.nba_games','id,season_year,nba_game_id,game_date,week_number,home_team,away_team,status,game_time,started_at',NULL),
    ('public.season_weeks','*',NULL),
    ('public.dynasty_pick_values','*',NULL),
    ('public.player_season_averages','league_id,league_season_id,season_year,player_id,avg_fantasy_points','league_id'),
    ('public.roster_players','league_season_id,player_id','league_season_id')
  ) AS targets(relation,columns,scope) LOOP
    arguments:=quote_literal(target.columns)||CASE WHEN target.scope IS NULL THEN '' ELSE ','||quote_literal(target.scope) END;
    FOREACH event_name IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      transition:=CASE event_name
        WHEN 'INSERT' THEN 'REFERENCING NEW TABLE AS trade_new'
        WHEN 'UPDATE' THEN 'REFERENCING OLD TABLE AS trade_old NEW TABLE AS trade_new'
        WHEN 'DELETE' THEN 'REFERENCING OLD TABLE AS trade_old' ELSE '' END;
      IF target.relation IN ('public.players','public.nba_games') AND event_name='UPDATE' THEN
        EXECUTE format('CREATE TRIGGER trade_input_update AFTER UPDATE ON %s FOR EACH ROW WHEN (ROW(%s) IS DISTINCT FROM ROW(%s)) EXECUTE FUNCTION private.track_trade_input_revision(%s)',
          target.relation,(SELECT string_agg('OLD.'||quote_ident(value),',') FROM unnest(string_to_array(target.columns,',')) value),
          (SELECT string_agg('NEW.'||quote_ident(value),',') FROM unnest(string_to_array(target.columns,',')) value),arguments);
      ELSE
        EXECUTE format('CREATE TRIGGER %I AFTER %s ON %s %s FOR EACH STATEMENT %s EXECUTE FUNCTION private.track_trade_input_revision(%s)',
          'trade_input_'||lower(event_name),event_name,target.relation,transition,
          CASE WHEN target.relation='analytics.player_season_totals' THEN 'WHEN (pg_trigger_depth()=0)' ELSE '' END,arguments);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluations(p_season_id uuid,p_version bigint,p_model text,p_after uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade record; queued integer:=0; last_id uuid; seen integer:=0;
BEGIN
  PERFORM private.compact_trade_input_revisions();
  FOR trade IN SELECT t.*,m.user_id FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id
    WHERE t.league_season_id=p_season_id AND t.status IN ('pending','accepted') AND (p_after IS NULL OR t.id>p_after)
    ORDER BY t.id LIMIT 20
  LOOP
    seen:=seen+1;
    last_id:=trade.id;
    IF private.work_enqueue('trade-revaluation-check',trade.id::text||':'||p_version::text||':'||p_model,now(),
      jsonb_build_object('checkInputs',true,'tradeId',trade.id,'memberId',trade.proposer_member_id,
        'userId',trade.user_id,'version',p_version),trade.league_id) IS NOT NULL THEN queued:=queued+1; END IF;
  END LOOP;
  IF seen=20 THEN
    PERFORM private.work_enqueue('trade-revaluation-scan',p_season_id::text||':'||p_version::text||':'||last_id::text,now(),
      jsonb_build_object('revaluationScan',true,'seasonId',p_season_id,'version',p_version,'after',last_id),
      (SELECT league_id FROM public.league_seasons WHERE id=p_season_id));
  END IF;
  RETURN jsonb_build_object('queued',queued);
END;
$$;

UPDATE private.work_items SET status='dead',completed_at=now(),last_error='Superseded by coalesced trade revaluation'
  WHERE kind='trade-revaluation' AND status IN ('pending','failed') AND key NOT LIKE '%:latest';
COMMIT;
