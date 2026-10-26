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
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'seasonYear',pick.season_year,'round',pick.round,
    'ownerId',pick.current_owner_id,'originalOwnerId',pick.original_owner_id,'originalTeamName',member.team_name,
    'slot',slot.pick_in_round) ORDER BY pick.id),'[]'::jsonb) INTO picks
  FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
  LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
  WHERE pick.id IN(SELECT (item->>'pickId')::uuid FROM jsonb_array_elements(terms) item);
  SELECT jsonb_agg(jsonb_build_object('memberId',member.id,'balance',COALESCE(balance.balance,league.faab_starting_budget)) ORDER BY member.id)
    INTO balances FROM public.league_members member LEFT JOIN public.faab_balances balance
    ON balance.member_id=member.id AND balance.league_season_id=season.id WHERE member.league_id=league.id
    AND member.id IN(SELECT (item->>'fromMemberId')::uuid FROM jsonb_array_elements(terms) item);
  RETURN jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,
    'teams',teams,'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'terms',terms,'players',player_rows,'replacementPlayers',replacement_rows,'picks',picks,'balances',balances);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.build_trade_estimate_inputs(p_user_id,p_member_id,p_items,true);
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
  SELECT jsonb_agg(jsonb_build_object('fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,
    'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount) ORDER BY i.id)
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  inputs:=private.build_trade_estimate_inputs(p_user_id,p_member_id,terms,false)
    ||jsonb_build_object('revaluationTradeId',p_trade_id);
  RETURN inputs||jsonb_build_object('inputVersion',md5(inputs::text),'observedAt',now());
END;
$$;

CREATE OR REPLACE FUNCTION public.save_trade_estimate_quote(
  p_user_id uuid,p_member_id uuid,p_inputs jsonb,p_analysis jsonb,p_model_version text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result public.trade_estimate_quotes%ROWTYPE; v_input_version text:=md5(p_inputs::text);
BEGIN
  IF p_inputs ? 'revaluationTradeId' THEN
    RAISE EXCEPTION 'A historical revaluation cannot become an offer quote.' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.league_members m JOIN public.league_seasons s ON s.league_id=m.league_id
    WHERE m.id=p_member_id AND m.user_id=p_user_id AND m.league_id=(p_inputs->>'leagueId')::uuid
      AND s.id=(p_inputs->>'seasonId')::uuid AND s.is_current) THEN
    RAISE EXCEPTION 'Not authorized to save this trade estimate.' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_analysis->'teams') IS DISTINCT FROM 'array' OR jsonb_typeof(p_analysis->'assets') IS DISTINCT FROM 'array'
    OR NULLIF(p_model_version,'') IS NULL THEN
    RAISE EXCEPTION 'A complete versioned trade estimate is required.' USING ERRCODE='22023';
  END IF;
  SELECT q.* INTO result FROM public.trade_estimate_quotes q
    WHERE q.member_id=p_member_id AND q.model_version=p_model_version AND q.input_version=v_input_version
      AND q.inputs=p_inputs AND q.expires_at>now() ORDER BY q.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    INSERT INTO public.trade_estimate_quotes(league_id,league_season_id,member_id,terms,inputs,analysis,model_version,input_version)
    VALUES((p_inputs->>'leagueId')::uuid,(p_inputs->>'seasonId')::uuid,p_member_id,p_inputs->'terms',p_inputs,p_analysis,p_model_version,v_input_version)
    RETURNING * INTO result;
  END IF;
  RETURN jsonb_build_object('id',result.id,'analysis',result.analysis,'modelVersion',result.model_version,
    'inputVersion',result.input_version,'createdAt',result.created_at,'expiresAt',result.expires_at,
    'seasonYear',(result.inputs->>'seasonYear')::integer,'terms',result.terms);
END;
$$;

REVOKE ALL ON FUNCTION private.build_trade_estimate_inputs(uuid,uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_trade_revaluation_inputs(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_revaluation_inputs(uuid,uuid,uuid) TO service_role;
