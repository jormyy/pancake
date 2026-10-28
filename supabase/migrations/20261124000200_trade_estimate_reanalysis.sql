BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='30s';
CREATE TABLE public.trade_estimate_history (
  trade_id uuid NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  formula_version text NOT NULL,
  quote_id uuid REFERENCES public.trade_estimate_quotes(id),
  snapshot jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(trade_id,formula_version)
);
CREATE INDEX trade_estimate_history_quote ON public.trade_estimate_history(quote_id);
ALTER TABLE public.trade_estimate_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY trade_estimate_history_read ON public.trade_estimate_history FOR SELECT TO authenticated USING(private.can_read_trade(trade_id));
REVOKE ALL ON public.trade_estimate_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.trade_estimate_history TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_inputs(p_trade_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  trade public.trades%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  terms jsonb; player_ids uuid[]; replacement_ids uuid[]; players jsonb; replacements jsonb; picks jsonb;
  actor uuid; teams integer; floor_value numeric; inputs jsonb;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id;
  IF EXISTS(SELECT 1 FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version='onenumber-trade-v1') THEN RETURN NULL; END IF;
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
    'valueBands',(SELECT jsonb_object_agg(v.tier,CASE WHEN v.round=3 THEN GREATEST(v.trade_value,floor_value) ELSE v.trade_value END)
      FROM public.dynasty_pick_values v WHERE v.draft_year=pick.season_year-1 AND v.round=pick.round),
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

CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_batch()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.id FROM public.trades t
  WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version='onenumber-trade-v1')
  ORDER BY t.id LIMIT 25;
$$;

CREATE OR REPLACE FUNCTION public.queue_trade_estimate_reanalysis()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE remaining bigint; completed bigint;
BEGIN
  SELECT count(*) INTO remaining FROM public.trades t WHERE t.status IN('pending','accepted','completed')
    AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.trade_id=t.id AND h.formula_version='onenumber-trade-v1');
  IF remaining=0 THEN RETURN 0; END IF;
  SELECT count(*) INTO completed FROM public.trade_estimate_history WHERE formula_version='onenumber-trade-v1';
  PERFORM private.work_enqueue('trade-estimate','onenumber-trade-v1:'||completed::text,now(),
    jsonb_build_object('reanalysisVersion','onenumber-trade-v1','completed',completed));
  RETURN remaining;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_trade_estimate_reanalysis(p_trade_id uuid,p_inputs jsonb,p_analysis jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE trade public.trades%ROWTYPE; quote uuid; original jsonb; terms jsonb;
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id FOR UPDATE;
  SELECT quote_id INTO quote FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version='onenumber-trade-v1';
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
    SELECT p_trade_id,'onenumber-trade-v1',q.id,to_jsonb(q) FROM public.trade_estimate_quotes q WHERE q.id=quote;
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(p_trade_id,quote)
    ON CONFLICT(trade_id) DO UPDATE SET quote_id=EXCLUDED.quote_id,unavailable_reason=NULL,recorded_at=now();
  RETURN quote;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_trade_estimate_quotes()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE removed integer;
BEGIN
  WITH expired AS (
    SELECT q.id FROM public.trade_estimate_quotes q WHERE q.expires_at<now()-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM public.trade_estimates e WHERE e.quote_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.quote_id=q.id)
    ORDER BY q.expires_at,q.id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.trade_estimate_quotes q USING expired WHERE q.id=expired.id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION private.retain_trade_estimate_quotes(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms' SET statement_timeout = '3s'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.id FROM public.trade_estimate_quotes r
    WHERE r.expires_at<p_now-interval '7 days' AND NOT EXISTS (SELECT 1 FROM public.trade_estimates e WHERE e.quote_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM public.trade_estimate_history h WHERE h.quote_id=r.id)
    ORDER BY r.expires_at,r.id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM public.trade_estimate_quotes r USING victims v WHERE r.id=v.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('public.trade_estimate_quotes',v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.get_trade_estimate_reanalysis_inputs(uuid),public.get_trade_estimate_reanalysis_batch(),public.queue_trade_estimate_reanalysis(),public.save_trade_estimate_reanalysis(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_trade_estimate_reanalysis_inputs(uuid),public.get_trade_estimate_reanalysis_batch(),public.queue_trade_estimate_reanalysis(),public.save_trade_estimate_reanalysis(uuid,jsonb,jsonb) TO service_role;
SELECT public.queue_trade_estimate_reanalysis();
COMMIT;
