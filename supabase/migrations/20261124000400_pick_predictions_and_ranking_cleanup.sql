BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.draft_picks
  ADD COLUMN predicted_tier_odds jsonb,
  ADD COLUMN predicted_trade_value numeric,
  ADD COLUMN predicted_value_bands jsonb,
  ADD COLUMN prediction_details jsonb,
  ADD COLUMN prediction_version text,
  ADD COLUMN predicted_at timestamptz,
  ADD COLUMN prediction_source_sha256 text,
  ADD CONSTRAINT predicted_pick_value_nonnegative CHECK(predicted_trade_value>=0),
  ADD CONSTRAINT predicted_pick_odds_valid CHECK(predicted_tier_odds IS NULL OR (
    jsonb_typeof(predicted_tier_odds)='object'
    AND (predicted_tier_odds->>'early')::numeric BETWEEN 0 AND 1
    AND (predicted_tier_odds->>'mid')::numeric BETWEEN 0 AND 1
    AND (predicted_tier_odds->>'late')::numeric BETWEEN 0 AND 1
    AND abs((predicted_tier_odds->>'early')::numeric+(predicted_tier_odds->>'mid')::numeric+(predicted_tier_odds->>'late')::numeric-1)<0.000001));
INSERT INTO private.work_kinds(kind,function_name) VALUES('pick-predictions','api/trades/pick-values-work');
DELETE FROM private.work_items WHERE kind='sync-rankings';
DELETE FROM private.work_kinds WHERE kind='sync-rankings';
DROP FUNCTION private.enqueue_rankings(timestamptz);
CREATE OR REPLACE FUNCTION public.replace_dynasty_rankings(
  p_source text,p_fetched_at timestamptz,p_rows jsonb,p_min_rows integer DEFAULT 100,
  p_scoring_format text DEFAULT 'overall',p_source_url text DEFAULT NULL,p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('retired',true,'source','onenumberhoops.com');
$$;
REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text,timestamptz,jsonb,integer,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text,timestamptz,jsonb,integer,text,text,jsonb) TO service_role;
DROP FUNCTION public.get_trade_estimate_reanalysis_batch();
DROP FUNCTION public.get_trade_estimate_reanalysis_inputs(uuid);
DROP FUNCTION public.save_trade_estimate_reanalysis(uuid,jsonb,jsonb);
DROP FUNCTION public.queue_trade_estimate_reanalysis();
CREATE OR REPLACE FUNCTION public.get_pick_prediction_leagues()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id FROM public.leagues l WHERE EXISTS(SELECT 1 FROM public.league_seasons WHERE league_id=l.id) ORDER BY l.id;
$$;

CREATE OR REPLACE FUNCTION public.get_pick_prediction_inputs(p_league_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE season public.league_seasons%ROWTYPE; team_count integer; floor_value numeric; result jsonb;
BEGIN
  SELECT * INTO season FROM public.league_seasons WHERE league_id=p_league_id ORDER BY is_current DESC,season_year DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO team_count FROM public.league_members WHERE league_id=p_league_id;
  SELECT LEAST(500,GREATEST(50,180.0*200/GREATEST(1,team_count*roster_size))) INTO floor_value FROM public.leagues WHERE id=p_league_id;
  WITH bands AS MATERIALIZED (
    SELECT * FROM public.get_dynasty_pick_values(p_league_id)
  )
  SELECT jsonb_build_object('leagueId',p_league_id,'seasonYear',season.season_year,
    'sourceVersion',(SELECT content_sha256 FROM private.trade_value_sync_state WHERE id),
    'seasonGames',(SELECT NULLIF(count(*)*2.0/GREATEST(1,team_count),0) FROM public.matchups
      WHERE league_season_id=season.id AND matchup_type='regular_season' AND NOT is_voided),
    'teams',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',member.id,'wins',COALESCE(record.wins,0),'ties',COALESCE(record.ties,0),
      'players',(SELECT COALESCE(jsonb_agg(jsonb_build_object('value',COALESCE(ranking.trade_value,0),'age',ranking.age)),'[]'::jsonb)
        FROM public.roster_players roster LEFT JOIN public.dynasty_rankings ranking
          ON ranking.player_id=roster.player_id AND ranking.source='onenumberhoops.com'
        WHERE roster.member_id=member.id AND roster.league_season_id=season.id)) ORDER BY member.id),'[]'::jsonb)
      FROM public.league_members member LEFT JOIN LATERAL (SELECT wins,ties FROM public.standings
        WHERE member_id=member.id AND league_season_id=season.id ORDER BY week_number DESC LIMIT 1) record ON true
      WHERE member.league_id=p_league_id),
    'games',(SELECT COALESCE(jsonb_agg(jsonb_build_object('home',home_member_id,'away',away_member_id) ORDER BY id),'[]'::jsonb)
      FROM public.matchups WHERE league_season_id=season.id AND matchup_type='regular_season' AND NOT is_finalized AND NOT is_voided),
    'picks',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'draftYear',pick.season_year-1,'round',pick.round,
      'originalOwnerId',pick.original_owner_id,'slot',slot.pick_in_round,
      'bands',(SELECT jsonb_object_agg(value.tier,value.trade_value) FROM (
        SELECT source.tier,COALESCE((SELECT band.trade_value FROM bands band WHERE band.draft_year=source.draft_year AND band.round=source.round AND band.tier=source.tier),CASE WHEN source.round=3 THEN GREATEST(source.trade_value,floor_value) ELSE source.trade_value END) AS trade_value
        FROM public.dynasty_pick_values source WHERE source.round=pick.round AND source.draft_year=(SELECT draft_year FROM public.dynasty_pick_values
          WHERE round=pick.round ORDER BY abs(draft_year-(pick.season_year-1)),draft_year LIMIT 1)
      ) value)) ORDER BY pick.id),'[]'::jsonb) FROM public.draft_picks pick
      LEFT JOIN LATERAL (SELECT pick_in_round FROM public.snake_draft_picks WHERE draft_pick_id=pick.id ORDER BY picked_at DESC NULLS LAST,id LIMIT 1) slot ON true
      WHERE pick.league_id=p_league_id AND pick.round BETWEEN 1 AND 3)) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_pick_predictions(p_league_id uuid,p_rows jsonb,p_source_version text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE updated integer;
BEGIN
  PERFORM 1 FROM private.trade_value_sync_state WHERE id AND content_sha256=p_source_version FOR SHARE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) row
    WHERE jsonb_typeof(row->'value') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row->'odds'->'early') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row->'odds'->'mid') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row->'odds'->'late') IS DISTINCT FROM 'number'
      OR (row->>'value')::numeric<LEAST((row->'bands'->>'early')::numeric,(row->'bands'->>'late')::numeric)-0.000001
      OR (row->>'value')::numeric>GREATEST((row->'bands'->>'early')::numeric,(row->'bands'->>'late')::numeric)+0.000001
      OR abs((row->'odds'->>'early')::numeric+(row->'odds'->>'mid')::numeric+(row->'odds'->>'late')::numeric-1)>0.000001) THEN
    RAISE EXCEPTION 'Invalid predicted pick values or odds.' USING ERRCODE='22023';
  END IF;
  UPDATE public.draft_picks pick SET predicted_tier_odds=row->'odds',predicted_trade_value=(row->>'value')::numeric,
    predicted_value_bands=row->'bands',prediction_details=row->'details',prediction_version='pick-finish-v1',
    predicted_at=now(),prediction_source_sha256=p_source_version
    FROM jsonb_array_elements(p_rows) row WHERE pick.id=(row->>'id')::uuid AND pick.league_id=p_league_id;
  GET DIAGNOSTICS updated=ROW_COUNT;
  RETURN updated;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_batch(p_run text DEFAULT 'onenumber-trade-v1')
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id FROM public.trades t
  WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version=p_run)
  ORDER BY t.id LIMIT 25;
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
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.player_id),'[]'::jsonb) INTO players
    FROM public.get_dynasty_forecast_inputs(league.id,trade.proposer_member_id,season.season_year,player_ids,'',100,0) p;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.player_id),'[]'::jsonb) INTO replacements
    FROM public.get_dynasty_forecast_inputs(league.id,trade.proposer_member_id,season.season_year,replacement_ids,'',5,0) p;
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

CREATE OR REPLACE FUNCTION public.save_trade_estimate_reanalysis(p_trade_id uuid,p_inputs jsonb,p_analysis jsonb,p_run text DEFAULT 'onenumber-trade-v1')
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
    VALUES(trade.league_id,trade.league_season_id,trade.proposer_member_id,terms,p_inputs,p_analysis,'onenumber-trade-v1',p_inputs->>'inputVersion',now()) RETURNING id INTO quote;
  INSERT INTO public.trade_estimate_history(trade_id,formula_version,quote_id,snapshot)
    SELECT p_trade_id,p_run,q.id,to_jsonb(q) FROM public.trade_estimate_quotes q WHERE q.id=quote;
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(p_trade_id,quote)
    ON CONFLICT(trade_id) DO UPDATE SET quote_id=EXCLUDED.quote_id,unavailable_reason=NULL,recorded_at=now();
  RETURN quote;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_trade_estimate_reanalysis(p_run text DEFAULT 'onenumber-trade-v1')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE remaining bigint; completed bigint;
BEGIN
  SELECT count(*) INTO remaining FROM public.trades t WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version=p_run);
  IF remaining=0 THEN RETURN 0; END IF;
  SELECT count(*) INTO completed FROM public.trade_estimate_history WHERE formula_version=p_run;
  PERFORM private.work_enqueue('trade-estimate','reanalysis:'||p_run||':'||completed::text,now(),
    jsonb_build_object('reanalysisVersion','onenumber-trade-v1','completed',completed,'runVersion',p_run));
  RETURN remaining;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_pick_prediction_refresh(p_source_version text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM private.trade_value_sync_state WHERE id AND content_sha256=p_source_version FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.draft_picks pick WHERE pick.round BETWEEN 1 AND 3
    AND EXISTS(SELECT 1 FROM public.league_seasons WHERE league_id=pick.league_id)
    AND pick.prediction_source_sha256 IS DISTINCT FROM p_source_version) THEN
    RAISE EXCEPTION 'Every league pick must refresh before trade re-analysis.' USING ERRCODE='40001';
  END IF;
  PERFORM public.queue_trade_estimate_reanalysis('onenumber-trade-v1-picks-v1');
  RETURN true;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.view_trade_details(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; trade public.trades%ROWTYPE; participants jsonb; items jsonb; estimate jsonb; unavailable text; result jsonb; analysis_context jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  SELECT * INTO trade FROM public.trades WHERE id = (p_params->>'tradeId')::uuid AND league_id = p_league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('context', context, 'trade', NULL, 'analysis', NULL); END IF;
  analysis_context := public.view_context(p_league_id, p_member_id, jsonb_build_object('seasonId', trade.league_season_id,'tradeId',trade.id));
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
  SELECT CASE WHEN quote.id IS NOT NULL THEN jsonb_build_object('quoteId', quote.id, 'modelVersion', quote.model_version,
    'inputVersion', quote.input_version, 'createdAt', quote.created_at, 'teams', quote.analysis->'teams', 'assets', quote.analysis->'assets') END,
    recorded.unavailable_reason INTO estimate, unavailable FROM public.trade_estimates recorded
    LEFT JOIN public.trade_estimate_quotes quote ON quote.id = recorded.quote_id WHERE recorded.trade_id = trade.id;
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
  RETURN jsonb_build_object('context', context, 'trade', result,
    'roster', public.view_roster(p_league_id, p_member_id, p_params - 'targetMemberId')->'roster',
    'savedQuote', (SELECT jsonb_build_object('id', q.id, 'analysis', q.analysis, 'modelVersion', q.model_version, 'inputVersion', q.input_version, 'createdAt', q.created_at, 'expiresAt', q.expires_at, 'seasonYear', q.inputs->'seasonYear') FROM public.trade_estimates e JOIN public.trade_estimate_quotes q ON q.id = e.quote_id WHERE e.trade_id = trade.id),
    'rosterPreview', CASE WHEN COALESCE((p_params->>'includeRosterPreview')::boolean, true)
      THEN public.view_trade_preview(p_league_id, p_member_id, p_params) END,
    'analysis', (SELECT revaluation FROM public.trade_value_cache WHERE trade_id = trade.id),
    'analysisStale', COALESCE((analysis_context->>'tradeAnalysisStale')::boolean,true));
END;
$$;

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
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.player_id),'[]'::jsonb) INTO player_rows
    FROM public.get_dynasty_forecast_inputs(league.id,p_member_id,season.season_year,player_ids,'',100,0) p;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.player_id),'[]'::jsonb) INTO replacement_rows
    FROM public.get_dynasty_forecast_inputs(league.id,p_member_id,season.season_year,replacement_ids,'',5,0) p;
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
REVOKE ALL ON FUNCTION public.get_pick_prediction_leagues(),public.get_pick_prediction_inputs(uuid),public.save_pick_predictions(uuid,jsonb,text),public.complete_pick_prediction_refresh(text),public.get_trade_estimate_reanalysis_batch(text),public.get_trade_estimate_reanalysis_inputs(uuid,text),public.save_trade_estimate_reanalysis(uuid,jsonb,jsonb,text),public.queue_trade_estimate_reanalysis(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_pick_prediction_leagues(),public.get_pick_prediction_inputs(uuid),public.save_pick_predictions(uuid,jsonb,text),public.complete_pick_prediction_refresh(text),public.get_trade_estimate_reanalysis_batch(text),public.get_trade_estimate_reanalysis_inputs(uuid,text),public.save_trade_estimate_reanalysis(uuid,jsonb,jsonb,text),public.queue_trade_estimate_reanalysis(text) TO service_role;
UPDATE private.work_items SET status='dead',lease_until=NULL,lease_token=NULL,completed_at=now()
  WHERE kind='trade-estimate' AND payload->>'reanalysisVersion'='onenumber-trade-v1' AND status IN('pending','running','failed');
DO $$
DECLARE state private.trade_value_sync_state%ROWTYPE;
BEGIN
  SELECT * INTO state FROM private.trade_value_sync_state WHERE id;
  IF state.content_sha256 IS NOT NULL THEN
    PERFORM private.work_enqueue('pick-predictions','initial:'||state.content_sha256,now(),jsonb_build_object('sourceVersion',state.content_sha256));
  END IF;
END;
$$;
COMMIT;
