BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION private.build_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb,p_require_ownership boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE; terms jsonb;
  v_item jsonb; seen text[]:='{}'; identity text; player_ids uuid[]; replacement_ids uuid[];
  player_rows jsonb; replacement_rows jsonb; player_input_rows jsonb; picks jsonb; balances jsonb; pick_values jsonb:='[]'::jsonb;
  rosters jsonb; best_free_agent numeric;
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
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId',member.id,
    'limits',jsonb_build_object('active',league.roster_size,'ir',league.ir_slots,'taxi',league.taxi_slots),
    'players',COALESCE((SELECT jsonb_agg(jsonb_build_object('playerId',roster.player_id,'location',
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END,
      'tradeValue',(SELECT ranking.trade_value FROM public.dynasty_rankings ranking
        WHERE ranking.player_id=roster.player_id AND ranking.source='onenumberhoops.com'
        ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)) ORDER BY roster.player_id)
      FROM public.roster_players roster WHERE roster.league_season_id=season.id AND roster.member_id=member.id),'[]'::jsonb))
    ORDER BY member.id),'[]'::jsonb) INTO rosters FROM public.league_members member WHERE member.league_id=league.id
    AND member.id IN(SELECT (item->>'fromMemberId')::uuid FROM jsonb_array_elements(terms) item
      UNION SELECT (item->>'toMemberId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT COALESCE(max(candidate.trade_value),0) INTO best_free_agent FROM (
    SELECT DISTINCT ON (ranking.player_id) ranking.player_id,ranking.trade_value
    FROM public.dynasty_rankings ranking JOIN public.players player ON player.id=ranking.player_id
    WHERE ranking.source='onenumberhoops.com' AND player.nba_team IS NOT NULL
      AND NOT ranking.player_id=ANY(player_ids)
      AND NOT EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id
        AND roster.player_id=ranking.player_id)
    ORDER BY ranking.player_id,ranking.fetched_at DESC,ranking.source_rank,ranking.id
  ) candidate WHERE candidate.trade_value BETWEEN 0 AND 1000;
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  RETURN jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,
    'teams',teams,'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'rosters',rosters,'bestFreeAgentValue',best_free_agent,'terms',terms,'players',player_rows,'replacementPlayers',replacement_rows,'picks',picks,'balances',balances);
END;
$$;

CREATE OR REPLACE FUNCTION private.trade_value_player_inputs(
  p_league_id uuid, p_member_id uuid, p_season_year integer, p_player_ids uuid[], p_limit integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET plan_cache_mode = force_generic_plan AS $$
BEGIN
  RETURN (
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
  ) END || jsonb_build_object('trade_value',market.trade_value) ORDER BY player.player_id), '[]'::jsonb)
  FROM input_rows player
  LEFT JOIN LATERAL (
    SELECT ranking.id, ranking.source_rank, ranking.rank_change, ranking.age, ranking.source, ranking.fetched_at, ranking.trade_value
      FROM public.dynasty_rankings ranking
     WHERE ranking.player_id = player.player_id AND ranking.source = 'onenumberhoops.com'
     ORDER BY ranking.fetched_at DESC, ranking.source_rank, ranking.id
     LIMIT 1
  ) market ON true);
END;
$$;
REVOKE ALL ON FUNCTION private.trade_value_player_inputs(uuid,uuid,integer,uuid[],integer) FROM PUBLIC,anon,authenticated,service_role;

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
      COALESCE((SELECT revaluation||jsonb_build_object('expiresAt',now()+interval '10 minutes')
        FROM public.trade_value_cache WHERE trade_id=p_trade_id AND revaluation->>'modelVersion'='onenumber-trade-curve-v5'),
        (SELECT jsonb_build_object('tradeId',p_trade_id,'analysis',quote.analysis,'modelVersion',quote.model_version,
          'inputVersion',quote.input_version,'createdAt',quote.created_at,'expiresAt',now()+interval '10 minutes',
          'seasonYear',quote.inputs->'seasonYear') FROM public.trade_estimates recorded
          JOIN public.trade_estimate_quotes quote ON quote.id=recorded.quote_id WHERE recorded.trade_id=p_trade_id
            AND quote.model_version='onenumber-trade-curve-v5')));
  END IF;
  fingerprint:=private.trade_revaluation_input_version(p_trade_id);
  SELECT jsonb_agg(jsonb_build_object('fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,
    'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount) ORDER BY i.id)
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  inputs:=private.build_trade_estimate_inputs(p_user_id,p_member_id,terms,false)
    ||jsonb_build_object('revaluationTradeId',p_trade_id,'pickPredictionVersions',(
      SELECT jsonb_agg(jsonb_build_array(pick.id,pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.trade_items item ON item.pick_id=pick.id WHERE item.trade_id=p_trade_id));
  inputs:=inputs||jsonb_build_object('playerDestinations',(
    SELECT COALESCE(jsonb_object_agg(item.player_id::text,CASE WHEN item.to_taxi THEN 'taxi' WHEN item.to_ir THEN 'ir' ELSE
      CASE WHEN EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=(inputs->>'seasonId')::uuid
        AND roster.player_id=item.player_id AND roster.is_on_taxi) THEN 'taxi' ELSE 'active' END END),'{}'::jsonb)
    FROM public.trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL));
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
    (SELECT cached.revaluation||jsonb_build_object('expiresAt',now()+interval '10 minutes')
      FROM private.trade_value_publications published
      JOIN public.trade_value_cache cached USING(trade_id)
      WHERE published.trade_id=p_trade_id AND published.input_fingerprint=fingerprint));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_inputs(p_trade_id uuid,p_run text DEFAULT 'onenumber-trade-curve-v5')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  trade public.trades%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  terms jsonb; player_ids uuid[]; replacement_ids uuid[]; players jsonb; replacements jsonb; picks jsonb;
  rosters jsonb; best_free_agent numeric;
  actor uuid; teams integer; floor_value numeric; inputs jsonb;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id;
  IF EXISTS(SELECT 1 FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version=p_run) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT league FROM public.leagues WHERE id=trade.league_id;
  SELECT * INTO STRICT season FROM public.league_seasons WHERE id=trade.league_season_id;
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
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId',member.id,
    'limits',jsonb_build_object('active',league.roster_size,'ir',league.ir_slots,'taxi',league.taxi_slots),
    'players',COALESCE((SELECT jsonb_agg(jsonb_build_object('playerId',roster.player_id,'location',
      CASE WHEN roster.is_on_taxi THEN 'taxi' WHEN roster.is_on_ir THEN 'ir' ELSE 'active' END,
      'tradeValue',(SELECT ranking.trade_value FROM public.dynasty_rankings ranking
        WHERE ranking.player_id=roster.player_id AND ranking.source='onenumberhoops.com'
        ORDER BY ranking.fetched_at DESC,ranking.source_rank,ranking.id LIMIT 1)) ORDER BY roster.player_id)
      FROM (
        SELECT roster.player_id,roster.is_on_ir,roster.is_on_taxi,CASE WHEN trade.status='completed' AND item.player_id IS NOT NULL
          THEN item.from_member_id ELSE roster.member_id END AS member_id
        FROM public.roster_players roster LEFT JOIN public.trade_items item ON item.trade_id=trade.id AND item.player_id=roster.player_id
        WHERE roster.league_season_id=season.id
        UNION ALL SELECT item.player_id,false,false,item.from_member_id FROM public.trade_items item
        WHERE item.trade_id=trade.id AND item.player_id IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id AND roster.player_id=item.player_id)
      ) roster WHERE roster.member_id=member.id),'[]'::jsonb))
    ORDER BY member.id),'[]'::jsonb) INTO rosters FROM public.league_members member WHERE member.league_id=league.id
    AND member.id IN(SELECT (item->>'fromMemberId')::uuid FROM jsonb_array_elements(terms) item
      UNION SELECT (item->>'toMemberId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT COALESCE(max(candidate.trade_value),0) INTO best_free_agent FROM (
    SELECT DISTINCT ON (ranking.player_id) ranking.player_id,ranking.trade_value
    FROM public.dynasty_rankings ranking JOIN public.players player ON player.id=ranking.player_id
    WHERE ranking.source='onenumberhoops.com' AND player.nba_team IS NOT NULL
      AND NOT ranking.player_id=ANY(player_ids)
      AND NOT EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id
        AND roster.player_id=ranking.player_id)
    ORDER BY ranking.player_id,ranking.fetched_at DESC,ranking.source_rank,ranking.id
  ) candidate WHERE candidate.trade_value BETWEEN 0 AND 1000;
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  inputs:=jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,'teams',teams,
    'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'rosters',rosters,'bestFreeAgentValue',best_free_agent,'terms',terms,'players',players,'replacementPlayers',replacements,'picks',picks,'revaluationTradeId',trade.id);
  inputs:=inputs||jsonb_build_object('playerDestinations',(
    SELECT COALESCE(jsonb_object_agg(item.player_id::text,CASE WHEN item.to_taxi THEN 'taxi' WHEN item.to_ir THEN 'ir' ELSE
      CASE WHEN EXISTS(SELECT 1 FROM public.roster_players roster WHERE roster.league_season_id=season.id
        AND roster.player_id=item.player_id AND roster.is_on_taxi) THEN 'taxi' ELSE 'active' END END),'{}'::jsonb)
    FROM public.trade_items item WHERE item.trade_id=p_trade_id AND item.player_id IS NOT NULL));
  RETURN inputs||jsonb_build_object('inputVersion',md5(inputs::text),'observedAt',now());
END;
$$;

CREATE OR REPLACE FUNCTION public.save_trade_estimate_reanalysis(p_trade_id uuid,p_inputs jsonb,p_analysis jsonb,p_run text DEFAULT 'onenumber-trade-curve-v5')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade public.trades%ROWTYPE; quote uuid; original jsonb; terms jsonb;
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id FOR UPDATE;
  SELECT quote_id INTO quote FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version=p_run;
  IF FOUND THEN RETURN quote; END IF;
  SELECT private.canonical_trade_estimate_terms(COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount)),'[]'::jsonb))
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  IF p_inputs->>'revaluationTradeId' IS DISTINCT FROM p_trade_id::text
    OR p_inputs->>'leagueId' IS DISTINCT FROM trade.league_id::text OR p_inputs->'terms' IS DISTINCT FROM terms
    OR jsonb_typeof(p_analysis->'teams') IS DISTINCT FROM 'array' OR jsonb_typeof(p_analysis->'assets') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Re-analysis must match the saved trade terms.' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object('estimate',to_jsonb(e),'quote',to_jsonb(q)) INTO original
    FROM public.trade_estimates e LEFT JOIN public.trade_estimate_quotes q ON q.id=e.quote_id WHERE e.trade_id=p_trade_id;
  INSERT INTO public.trade_estimate_history(trade_id,formula_version,quote_id,snapshot)
    SELECT p_trade_id,'original',e.quote_id,original FROM public.trade_estimates e WHERE e.trade_id=p_trade_id
    ON CONFLICT DO NOTHING;
  IF original IS NULL THEN
    INSERT INTO public.trade_estimate_history(trade_id,formula_version,snapshot) VALUES(p_trade_id,'original',jsonb_build_object('estimate',NULL,'quote',NULL)) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO public.trade_estimate_quotes(league_id,league_season_id,member_id,terms,inputs,analysis,model_version,input_version,expires_at)
    VALUES(trade.league_id,trade.league_season_id,trade.proposer_member_id,terms,p_inputs,p_analysis,'onenumber-trade-curve-v5',p_inputs->>'inputVersion',now()) RETURNING id INTO quote;
  INSERT INTO public.trade_estimate_history(trade_id,formula_version,quote_id,snapshot)
    SELECT p_trade_id,p_run,q.id,to_jsonb(q) FROM public.trade_estimate_quotes q WHERE q.id=quote;
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(p_trade_id,quote)
    ON CONFLICT(trade_id) DO UPDATE SET quote_id=EXCLUDED.quote_id,unavailable_reason=NULL,recorded_at=now();
  RETURN quote;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_batch(p_run text DEFAULT 'onenumber-trade-curve-v5')
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id FROM public.trades t
  WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version=p_run)
  ORDER BY t.id LIMIT 25;
$$;

CREATE OR REPLACE FUNCTION public.queue_trade_estimate_reanalysis(p_run text DEFAULT 'onenumber-trade-curve-v5')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE remaining bigint; completed bigint;
BEGIN
  SELECT count(*) INTO remaining FROM public.trades t WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version=p_run);
  IF remaining=0 THEN RETURN 0; END IF;
  SELECT count(*) INTO completed FROM public.trade_estimate_history WHERE formula_version=p_run;
  PERFORM private.work_enqueue('trade-estimate','reanalysis:'||p_run||':'||completed::text,now(),
    jsonb_build_object('reanalysisVersion','onenumber-trade-curve-v5','completed',completed,'runVersion',p_run));
  RETURN remaining;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_cards(p_league_id uuid,p_member_id uuid,p_trade_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE cards jsonb; current_year integer:=public.current_season_year_et(); teams integer;
BEGIN
  PERFORM public.view_context(p_league_id,p_member_id);
  IF p_trade_ids IS NULL OR cardinality(p_trade_ids)>100 THEN
    RAISE EXCEPTION 'Choose at most 100 trades.' USING ERRCODE='22023';
  END IF;
  IF cardinality(p_trade_ids)=0 THEN RETURN '[]'::jsonb; END IF;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=p_league_id;
  WITH own_members AS MATERIALIZED (
    SELECT id FROM public.league_members WHERE league_id=p_league_id AND user_id=auth.uid()
  ), requested AS MATERIALIZED (
    SELECT id,ordinal FROM unnest(p_trade_ids) WITH ORDINALITY row(id,ordinal)
  ), chosen AS MATERIALIZED (
    SELECT trade.* FROM public.trades trade WHERE trade.league_id=p_league_id AND trade.id=ANY(p_trade_ids)
      AND (trade.status='accepted' OR trade.proposer_member_id IN(SELECT id FROM own_members)
        OR trade.recipient_member_id IN(SELECT id FROM own_members)
        OR EXISTS(SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id=trade.id
          AND participant.member_id IN(SELECT id FROM own_members)))
  ), participants AS (
    SELECT participant.trade_id,COALESCE(jsonb_agg(jsonb_build_object('memberId',participant.member_id,
      'teamName',COALESCE(member.team_name,'Unknown'),'sortOrder',participant.sort_order,
      'isInitiator',participant.is_initiator,'acceptedAt',participant.accepted_at,
      'dropPlayerIds',participant.drop_player_ids,'rosterMoves',participant.roster_moves)
      ORDER BY participant.sort_order,member.team_name,participant.member_id),'[]') AS value
    FROM chosen trade JOIN public.trade_participants participant ON participant.trade_id=trade.id
    LEFT JOIN public.league_members member ON member.id=participant.member_id AND member.league_id=p_league_id
    GROUP BY participant.trade_id
  ), pick_values AS MATERIALIZED (
    SELECT value.* FROM public.get_dynasty_pick_values(p_league_id) value
    WHERE EXISTS(SELECT 1 FROM chosen trade JOIN public.trade_items item ON item.trade_id=trade.id
      JOIN public.draft_picks pick ON pick.id=item.pick_id WHERE pick.predicted_trade_value IS NULL)
  ), items AS (
    SELECT item.trade_id, COALESCE(jsonb_agg(CASE WHEN item.player_id IS NOT NULL THEN jsonb_build_object('kind', 'player',
      'tradeValue', (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1),
      'playerId', player.id, 'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position,
      'eligiblePositions', player.eligible_positions, 'nbaTeam', player.nba_team, 'nbaId', player.nba_id,
      'injuryStatus', player.injury_status, 'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number,
      'careerGames', player.career_regular_season_games, 'toTaxi', item.to_taxi, 'toIR', item.to_ir,
      'fromTaxi', EXISTS (SELECT 1 FROM public.roster_players r WHERE r.player_id = player.id AND r.member_id = item.from_member_id
        AND r.league_season_id = trade.league_season_id AND r.is_on_taxi),
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    WHEN item.pick_id IS NOT NULL THEN jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'tradeValue', COALESCE(pick.predicted_trade_value,(SELECT value.trade_value FROM pick_values value
        WHERE value.draft_year=pick.season_year-1 AND value.round=pick.round AND value.tier=CASE
          WHEN slot.pick_in_round IS NULL THEN 'mid'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)/3.0) THEN 'early'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,teams)*2/3.0) THEN 'mid'
          ELSE 'late' END)),
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown'))
    ELSE jsonb_build_object('kind', 'faab', 'amount', item.faab_amount) END
    || jsonb_build_object('fromMemberId', item.from_member_id, 'toMemberId', item.to_member_id) ORDER BY item.id), '[]')
    AS value FROM public.trade_items item JOIN chosen trade ON trade.id=item.trade_id LEFT JOIN public.players player ON player.id = item.player_id
    LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id AND pick.league_id=p_league_id LEFT JOIN public.league_members original ON original.id = pick.original_owner_id AND original.league_id=p_league_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = current_year
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = current_year
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = current_year
    GROUP BY item.trade_id

  )
  SELECT COALESCE(jsonb_agg(CASE WHEN trade.id IS NOT NULL THEN jsonb_build_object('id', trade.id, 'status', trade.status, 'completionFailureReason', trade.completion_failure_reason,
    'proposedAt', trade.proposed_at, 'acceptedAt', trade.accepted_at, 'vetoWindowExpiresAt', trade.veto_window_expires_at,
    'completedAt', trade.completed_at, 'vetoedAt', trade.vetoed_at, 'expiresAt', trade.expires_at, 'notes', trade.notes,
    'proposerMemberId', trade.proposer_member_id, 'proposerTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.proposer_member_id), 'Unknown'),
    'recipientMemberId', trade.recipient_member_id, 'recipientTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.recipient_member_id), 'Unknown'),
    'isMultiTeam', trade.is_multi_team, 'participants', COALESCE(participants.value,'[]'::jsonb), 'parentTradeId', trade.parent_trade_id,
    'counteredFromTradeId', trade.countered_from_trade_id, 'editedFromTradeId', trade.edited_from_trade_id, 'replacedByTradeId', trade.replaced_by_trade_id,
    'version', trade.version, 'proposerFaabAmount', trade.proposer_faab_amount, 'recipientFaabAmount', trade.recipient_faab_amount,
    'myVetoed', EXISTS (SELECT 1 FROM public.trade_vetos WHERE trade_id = trade.id AND member_id = p_member_id),
    'routedItems', COALESCE(items.value,'[]'::jsonb), 'estimate', CASE WHEN quote.id IS NOT NULL OR cached.trade_id IS NOT NULL THEN jsonb_build_object('quoteId',quote.id,'modelVersion',COALESCE(cached.revaluation->>'modelVersion',quote.model_version),'inputVersion',COALESCE(cached.revaluation->>'inputVersion',quote.input_version),'createdAt',COALESCE(cached.revaluation->>'createdAt',quote.created_at::text),'teams',COALESCE(cached.revaluation->'analysis'->'teams',quote.analysis->'teams'),'assets',COALESCE(cached.revaluation->'analysis'->'assets',quote.analysis->'assets')) END, 'estimateUnavailable', recorded.unavailable_reason) END ORDER BY requested.ordinal),'[]')
  INTO cards FROM requested LEFT JOIN chosen trade ON trade.id=requested.id
    LEFT JOIN participants ON participants.trade_id=trade.id LEFT JOIN items ON items.trade_id=trade.id
    LEFT JOIN public.trade_estimates recorded ON recorded.trade_id=trade.id
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id=recorded.quote_id
    LEFT JOIN public.trade_value_cache cached ON cached.trade_id=trade.id AND cached.revaluation->>'modelVersion'='onenumber-trade-curve-v5';
  RETURN cards;
END;
$$;
REVOKE ALL ON FUNCTION public.get_trade_cards(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_trade_cards(uuid,uuid,uuid[]) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.view_trade_details(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; trade public.trades%ROWTYPE; participants jsonb; items jsonb; estimate jsonb; unavailable text; result jsonb; analysis_context jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO trade FROM public.trades WHERE id = (p_params->>'tradeId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'trade', NULL, 'analysis', NULL); END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('memberId', participant.member_id, 'teamName', COALESCE(member.team_name, 'Unknown'),
    'sortOrder', participant.sort_order, 'isInitiator', participant.is_initiator, 'acceptedAt', participant.accepted_at,
    'dropPlayerIds', participant.drop_player_ids, 'rosterMoves', participant.roster_moves)
    ORDER BY participant.sort_order, member.team_name, participant.member_id), '[]')
  INTO participants FROM public.trade_participants participant LEFT JOIN public.league_members member ON member.id = participant.member_id
    WHERE participant.trade_id = trade.id;
  SELECT COALESCE(jsonb_agg(CASE WHEN item.player_id IS NOT NULL THEN jsonb_build_object('kind', 'player',
      'tradeValue', (SELECT ranking.trade_value FROM public.dynasty_rankings ranking WHERE ranking.player_id=player.id AND ranking.source='onenumberhoops.com' ORDER BY ranking.fetched_at DESC,ranking.source_rank LIMIT 1),
      'playerId', player.id, 'playerName', COALESCE(player.display_name, 'Unknown'), 'position', player.position,
      'eligiblePositions', player.eligible_positions, 'nbaTeam', player.nba_team, 'nbaId', player.nba_id,
      'injuryStatus', player.injury_status, 'yearsExp', player.years_exp, 'nbaDraftNumber', player.nba_draft_number,
      'careerGames', player.career_regular_season_games, 'toTaxi', item.to_taxi, 'toIR', item.to_ir,
      'fromTaxi', EXISTS (SELECT 1 FROM public.roster_players r WHERE r.player_id = player.id AND r.member_id = item.from_member_id
        AND r.league_season_id = trade.league_season_id AND r.is_on_taxi),
      'avgFantasyPoints', COALESCE(average.avg_fantasy_points, source_fantasy.avg_fantasy_points),
      'avgMinutesPlayed', COALESCE(average.averages->'avg_minutes_played', to_jsonb(source_average.avg_minutes_played)))
    WHEN item.pick_id IS NOT NULL THEN jsonb_build_object('kind', 'pick', 'pickId', pick.id, 'seasonYear', pick.season_year,
      'tradeValue', COALESCE(pick.predicted_trade_value,(SELECT value.trade_value FROM public.get_dynasty_pick_values(p_league_id) value
        WHERE value.draft_year=pick.season_year-1 AND value.round=pick.round AND value.tier=CASE
          WHEN slot.pick_in_round IS NULL THEN 'mid'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,(SELECT count(*) FROM public.league_members WHERE league_id=p_league_id))/3.0) THEN 'early'
          WHEN slot.pick_in_round<=ceil(GREATEST(4,(SELECT count(*) FROM public.league_members WHERE league_id=p_league_id))*2/3.0) THEN 'mid'
          ELSE 'late' END)),
      'round', pick.round, 'originalTeamName', COALESCE(original.team_name, 'Unknown'))
    ELSE jsonb_build_object('kind', 'faab', 'amount', item.faab_amount) END
    || jsonb_build_object('fromMemberId', item.from_member_id, 'toMemberId', item.to_member_id) ORDER BY item.id), '[]')
  INTO items FROM public.trade_items item LEFT JOIN public.players player ON player.id = item.player_id
    LEFT JOIN public.draft_picks pick ON pick.id = item.pick_id LEFT JOIN public.league_members original ON original.id = pick.original_owner_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    LEFT JOIN public.player_season_averages average ON average.league_id = p_league_id AND average.player_id = item.player_id
      AND average.season_year = public.current_season_year_et()
    LEFT JOIN public.mv_player_season_averages source_average ON average.player_id IS NULL AND source_average.player_id = item.player_id
      AND source_average.season_year = public.current_season_year_et()
    LEFT JOIN public.v_player_avg_fantasy_points source_fantasy ON average.player_id IS NULL AND source_fantasy.league_id = p_league_id
      AND source_fantasy.player_id = item.player_id AND source_fantasy.season_year = public.current_season_year_et()
    WHERE item.trade_id = trade.id;
  SELECT CASE WHEN quote.id IS NOT NULL OR cached.trade_id IS NOT NULL THEN jsonb_build_object('quoteId', quote.id,
    'modelVersion',COALESCE(cached.revaluation->>'modelVersion',quote.model_version),
    'inputVersion',COALESCE(cached.revaluation->>'inputVersion',quote.input_version),
    'createdAt',COALESCE(cached.revaluation->>'createdAt',quote.created_at::text),
    'teams',COALESCE(cached.revaluation->'analysis'->'teams',quote.analysis->'teams'),
    'assets',COALESCE(cached.revaluation->'analysis'->'assets',quote.analysis->'assets')) END,
    recorded.unavailable_reason INTO estimate, unavailable FROM public.trade_estimates recorded
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id = recorded.quote_id
    LEFT JOIN public.trade_value_cache cached ON cached.trade_id=trade.id AND cached.revaluation->>'modelVersion'='onenumber-trade-curve-v5'
    WHERE recorded.trade_id = trade.id;
  result := jsonb_build_object('id', trade.id, 'status', trade.status, 'completionFailureReason', trade.completion_failure_reason,
    'proposedAt', trade.proposed_at, 'acceptedAt', trade.accepted_at, 'vetoWindowExpiresAt', trade.veto_window_expires_at,
    'completedAt', trade.completed_at, 'vetoedAt', trade.vetoed_at, 'expiresAt', trade.expires_at, 'notes', trade.notes,
    'proposerMemberId', trade.proposer_member_id, 'proposerTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.proposer_member_id), 'Unknown'),
    'recipientMemberId', trade.recipient_member_id, 'recipientTeamName', COALESCE((SELECT team_name FROM public.league_members WHERE id = trade.recipient_member_id), 'Unknown'),
    'isMultiTeam', trade.is_multi_team, 'participants', participants, 'parentTradeId', trade.parent_trade_id,
    'counteredFromTradeId', trade.countered_from_trade_id, 'editedFromTradeId', trade.edited_from_trade_id, 'replacedByTradeId', trade.replaced_by_trade_id,
    'version', trade.version, 'proposerFaabAmount', trade.proposer_faab_amount, 'recipientFaabAmount', trade.recipient_faab_amount,
    'myVetoed', EXISTS (SELECT 1 FROM public.trade_vetos WHERE trade_id = trade.id AND member_id = p_member_id),
    'routedItems', items, 'estimate', estimate, 'estimateUnavailable', unavailable);
  IF COALESCE((p_params->>'cardOnly')::boolean, false) THEN
    RETURN jsonb_build_object('trade', result);
  END IF;
  analysis_context := public.view_context(p_league_id, p_member_id, jsonb_build_object('seasonId', trade.league_season_id,'tradeId',trade.id));
  RETURN jsonb_build_object('context', context, 'trade', result,
    'roster', public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId')->'roster',
    'savedQuote', (SELECT jsonb_build_object('id', q.id, 'analysis', q.analysis, 'modelVersion', q.model_version, 'inputVersion', q.input_version, 'createdAt', q.created_at, 'expiresAt', q.expires_at, 'seasonYear', q.inputs->'seasonYear') FROM public.trade_estimates e JOIN public.trade_estimate_quotes q ON q.id = e.quote_id WHERE e.trade_id = trade.id),
    'rosterPreview', CASE WHEN COALESCE((p_params->>'includeRosterPreview')::boolean, true)
      THEN public.view_trade_preview(p_league_id, p_member_id, p_params) END,
    'analysis', (SELECT revaluation FROM public.trade_value_cache WHERE trade_id = trade.id),
    'analysisStale', COALESCE((analysis_context->>'tradeAnalysisStale')::boolean,true));
END;
$$;

SELECT public.queue_trade_estimate_reanalysis('onenumber-trade-curve-v5');
COMMIT;
