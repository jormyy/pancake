BEGIN;
ALTER TABLE private.screen_refresh_queue ADD COLUMN averages_initialized boolean NOT NULL DEFAULT false;
ALTER TABLE private.screen_refresh_queue ADD COLUMN averages_scoring jsonb;
ALTER TABLE private.trade_value_publications ADD COLUMN input_fingerprint text;
ALTER TABLE private.trade_value_publications ADD COLUMN model_version text;
CREATE TABLE private.screen_average_dirty(
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  player_id uuid NOT NULL,
  PRIMARY KEY(league_season_id,player_id)
);
ALTER TABLE private.screen_average_dirty ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.screen_average_dirty FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX player_season_averages_replacement ON public.player_season_averages(league_id,season_year,avg_fantasy_points DESC,player_id);
INSERT INTO private.work_kinds(kind,function_name) VALUES('trade-revaluation','refresh-views'),('trade-revaluation-scan','refresh-views'),('trade-revaluation-check','refresh-views');
CREATE OR REPLACE FUNCTION private.refresh_changed_screen_views()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['updated_at','set_at']) IS NOT DISTINCT FROM (to_jsonb(NEW)-ARRAY['updated_at','set_at']) THEN RETURN NULL; END IF;
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='league_seasons' AND TG_OP='UPDATE'
    AND to_jsonb(OLD)->>'season_year' IS DISTINCT FROM row_data->>'season_year' THEN
    UPDATE private.screen_refresh_queue SET averages_initialized=false WHERE league_season_id=(row_data->>'id')::uuid;
  END IF;
  IF TG_TABLE_NAME='league_change_hints' AND row_data->>'topic'='inventory'
    AND EXISTS(SELECT 1 FROM private.league_version_pending
      WHERE transaction_id=pg_current_xact_id() AND league_id=(row_data->>'league_id')::uuid) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME<>'league_change_hints' AND current_setting('pancake.trade_write',true)='true' THEN
    PERFORM private.queue_trade_publication(
      CASE WHEN TG_TABLE_NAME='leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'league_change_hints' AND row_data->>'topic' = 'version'
    AND jsonb_array_length(COALESCE(row_data->'details'->0->'scope'->'tables', '[]')) > 0
    AND row_data->'details'->0->'scope'->'tables' <@ '["standings_current","matchup_totals","player_season_averages","trade_value_cache","matchup_forecasts"]'::jsonb THEN
    RETURN NULL;
  END IF;
  PERFORM private.refresh_queue_screen_views(
    CASE WHEN TG_TABLE_NAME = 'leagues' THEN (row_data->>'id')::uuid ELSE (row_data->>'league_id')::uuid END);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_changed_player_averages()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    UPDATE private.screen_refresh_queue SET averages_initialized=false;
    RETURN NULL;
  END IF;
  IF TG_OP<>'DELETE' THEN
    INSERT INTO private.screen_average_dirty(league_season_id,player_id)
      SELECT season.id,NEW.player_id FROM public.league_seasons season WHERE season.season_year=NEW.season_year
      ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP<>'INSERT' THEN
    INSERT INTO private.screen_average_dirty(league_season_id,player_id)
      SELECT season.id,OLD.player_id FROM public.league_seasons season WHERE season.season_year=OLD.season_year
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_player_averages(p_league_id uuid, p_season_id uuid, p_version bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE selected_year integer; settings jsonb; full_refresh boolean; affected uuid[];
BEGIN
  PERFORM 1 FROM private.screen_refresh_queue WHERE league_id = p_league_id AND league_season_id = p_season_id AND version = p_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT season.season_year,league.scoring_settings,
    NOT queued.averages_initialized OR queued.averages_scoring IS DISTINCT FROM league.scoring_settings
    INTO STRICT selected_year,settings,full_refresh
    FROM public.league_seasons season JOIN public.leagues league ON league.id=season.league_id
    JOIN private.screen_refresh_queue queued ON queued.league_season_id=season.id WHERE season.id=p_season_id;
  SELECT array_agg(player_id) INTO affected FROM (
    SELECT player_id FROM private.screen_average_dirty WHERE league_season_id=p_season_id FOR UPDATE
  ) changed;
  IF NOT full_refresh AND affected IS NULL THEN RETURN true; END IF;
  WITH source AS MATERIALIZED (
    SELECT COALESCE(average.player_id,fantasy.player_id) AS player_id,average.averages,fantasy.avg_fantasy_points
    FROM (SELECT average.player_id,to_jsonb(average) AS averages FROM public.mv_player_season_averages average WHERE average.season_year=selected_year AND (full_refresh OR average.player_id=ANY(affected))) average
    FULL JOIN (SELECT player_id,avg_fantasy_points FROM public.v_player_avg_fantasy_points WHERE league_id=p_league_id AND season_year=selected_year AND (full_refresh OR player_id=ANY(affected))) fantasy USING(player_id)
  ), changed AS (
    INSERT INTO public.player_season_averages AS cached(league_id,league_season_id,season_year,player_id,averages,avg_fantasy_points,version)
    SELECT p_league_id,p_season_id,selected_year,source.player_id,source.averages,source.avg_fantasy_points,p_version FROM source
    ON CONFLICT(league_id,season_year,player_id) DO UPDATE SET averages=EXCLUDED.averages,avg_fantasy_points=EXCLUDED.avg_fantasy_points,
      version=EXCLUDED.version,refreshed_at=now() WHERE cached.version<=EXCLUDED.version
      AND (md5((to_jsonb(cached)-ARRAY['version','refreshed_at'])::text)
        IS DISTINCT FROM md5((to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at'])::text)
        OR (to_jsonb(cached)-ARRAY['version','refreshed_at']) IS DISTINCT FROM (to_jsonb(EXCLUDED)-ARRAY['version','refreshed_at']))
    RETURNING player_id
  )
  DELETE FROM public.player_season_averages cached WHERE cached.league_season_id=p_season_id
    AND (full_refresh OR cached.player_id=ANY(affected))
    AND (cached.season_year<>selected_year OR NOT EXISTS(SELECT 1 FROM source WHERE source.player_id=cached.player_id));
  DELETE FROM private.screen_average_dirty WHERE league_season_id=p_season_id AND player_id=ANY(affected);
  UPDATE private.screen_refresh_queue SET averages_initialized=true,averages_scoring=settings WHERE league_season_id=p_season_id;
  RETURN true;
END;
$$;

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
    FROM public.v_player_avg_fantasy_points
   WHERE league_id = p_league_id
     AND season_year = p_season_year AND player_id=ANY(p_player_ids)
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
      SELECT player_id,league_id,season_year,avg_fantasy_points FROM public.v_player_avg_fantasy_points
        WHERE league_id=league.id AND season_year=season.season_year AND NOT EXISTS(
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

CREATE OR REPLACE FUNCTION public.get_trade_revaluation_inputs(p_user_id uuid,p_member_id uuid,p_trade_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  terms jsonb; inputs jsonb;
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
  RETURN inputs||jsonb_build_object('inputVersion',md5(inputs::text),'observedAt',now(),'cachedRevaluation',
    (SELECT cached.revaluation FROM private.trade_value_publications published
      JOIN public.trade_value_cache cached USING(trade_id)
      WHERE published.trade_id=p_trade_id AND published.input_fingerprint=md5(inputs::text)));
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
    inputs:=public.get_trade_revaluation_inputs(trade.user_id,trade.proposer_member_id,trade.id);
    IF inputs->>'inputVersion' IS DISTINCT FROM value->>'inputVersion' THEN
      PERFORM private.refresh_queue_trade_revaluation(trade.id,inputs->>'inputVersion',value->>'modelVersion',inputs);
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

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluation(p_trade_id uuid,p_fingerprint text,p_model text,p_inputs jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade record; work_key text; work_payload jsonb;
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
  work_key:=trade.id::text||':'||p_model||':'||p_fingerprint;
  work_payload:=jsonb_build_object('tradeId',trade.id,'memberId',trade.proposer_member_id,'userId',trade.user_id,
    'inputFingerprint',p_fingerprint,'modelVersion',p_model,'inputs',p_inputs);
  UPDATE private.work_items SET status='pending',attempts=0,due_at=now(),completed_at=NULL,payload=work_payload,
    last_error=NULL,invocation_key=NULL WHERE kind='trade-revaluation' AND key=work_key AND status='succeeded';
  IF FOUND THEN RETURN true; END IF;
  RETURN private.work_enqueue('trade-revaluation',work_key,now(),work_payload,trade.league_id) IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.refresh_queue_trade_revaluations(p_season_id uuid,p_version bigint,p_model text,p_after uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade record; queued integer:=0; last_id uuid; seen integer:=0;
BEGIN
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

CREATE OR REPLACE FUNCTION public.view_refresh_work(p_league_id uuid DEFAULT NULL, p_member_id uuid DEFAULT NULL, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE queued private.screen_refresh_queue%ROWTYPE; result jsonb; completed boolean;
BEGIN
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

CREATE TRIGGER refresh_player_average_changes AFTER INSERT OR UPDATE OR DELETE ON analytics.player_season_totals
  FOR EACH ROW EXECUTE FUNCTION private.refresh_changed_player_averages();
CREATE TRIGGER refresh_player_average_reset AFTER TRUNCATE ON analytics.player_season_totals
  FOR EACH STATEMENT EXECUTE FUNCTION private.refresh_changed_player_averages();
REVOKE ALL ON FUNCTION private.refresh_changed_player_averages(),private.refresh_queue_trade_revaluation(uuid,text,text,jsonb),private.refresh_queue_trade_revaluations(uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
