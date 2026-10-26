CREATE TABLE public.trade_estimate_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id uuid NOT NULL REFERENCES public.leagues(id) ON DELETE CASCADE,
  league_season_id uuid NOT NULL REFERENCES public.league_seasons(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.league_members(id) ON DELETE CASCADE,
  terms jsonb NOT NULL,
  inputs jsonb NOT NULL,
  analysis jsonb NOT NULL,
  model_version text NOT NULL,
  input_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);

CREATE INDEX trade_estimate_cache ON public.trade_estimate_quotes(member_id,model_version,input_version,expires_at);

CREATE TABLE public.trade_estimates (
  trade_id uuid PRIMARY KEY REFERENCES public.trades(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES public.trade_estimate_quotes(id),
  unavailable_reason text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((quote_id IS NOT NULL) <> (unavailable_reason IS NOT NULL))
);

CREATE INDEX trade_estimate_quote_links ON public.trade_estimates(quote_id);
ALTER TABLE public.trade_estimate_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_estimates ENABLE ROW LEVEL SECURITY;
CREATE POLICY trade_estimate_read ON public.trade_estimates FOR SELECT TO authenticated
  USING(private.can_read_trade(trade_id));
CREATE POLICY trade_estimate_quote_read ON public.trade_estimate_quotes FOR SELECT TO authenticated
  USING(member_id IN(SELECT private.my_member_ids()) OR EXISTS(
    SELECT 1 FROM public.trade_estimates snapshot WHERE snapshot.quote_id=trade_estimate_quotes.id));
REVOKE ALL ON public.trade_estimate_quotes,public.trade_estimates FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.trade_estimate_quotes,public.trade_estimates TO authenticated;
GRANT SELECT,INSERT ON public.trade_estimate_quotes,public.trade_estimates TO service_role;

CREATE OR REPLACE FUNCTION private.canonical_trade_estimate_terms(p_items jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
    'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
    'faabAmount',COALESCE((item->>'faabAmount')::integer,0))
    ORDER BY item->>'fromMemberId',item->>'toMemberId',item->>'playerId',item->>'pickId',COALESCE((item->>'faabAmount')::integer,0)),
    '[]'::jsonb) FROM jsonb_array_elements(p_items) item;
$$;

CREATE OR REPLACE FUNCTION public.get_trade_estimate_inputs(p_user_id uuid,p_member_id uuid,p_items jsonb)
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
    IF v_item->>'playerId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.roster_players r
      WHERE r.league_id=league.id AND r.league_season_id=season.id AND r.member_id=(v_item->>'fromMemberId')::uuid
        AND r.player_id=(v_item->>'playerId')::uuid) THEN
      RAISE EXCEPTION 'A selected player is no longer owned by the sending team.' USING ERRCODE='22023';
    END IF;
    IF v_item->>'pickId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.draft_picks p
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

CREATE OR REPLACE FUNCTION public.save_trade_estimate_quote(
  p_user_id uuid,p_member_id uuid,p_inputs jsonb,p_analysis jsonb,p_model_version text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result public.trade_estimate_quotes%ROWTYPE; v_input_version text:=md5(p_inputs::text);
BEGIN
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

CREATE OR REPLACE FUNCTION private.attach_trade_estimate(p_trade_id uuid,p_member_id uuid,p_quote_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE quote public.trade_estimate_quotes%ROWTYPE; trade public.trades%ROWTYPE; terms jsonb;
BEGIN
  IF p_quote_id IS NULL THEN
    INSERT INTO public.trade_estimates(trade_id,unavailable_reason) VALUES(p_trade_id,'No saved estimate was available when these terms were submitted.');
    RETURN;
  END IF;
  SELECT * INTO quote FROM public.trade_estimate_quotes WHERE id=p_quote_id;
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id;
  SELECT private.canonical_trade_estimate_terms(COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount)),'[]'::jsonb))
    INTO terms FROM public.trade_items i WHERE i.trade_id=p_trade_id;
  IF quote.id IS NULL OR quote.member_id<>p_member_id OR quote.league_id<>trade.league_id
    OR quote.league_season_id<>trade.league_season_id OR quote.terms IS DISTINCT FROM terms THEN
    RAISE EXCEPTION 'This estimate belongs to different trade terms. Review the current estimate and try again.' USING ERRCODE='22023';
  END IF;
  IF quote.expires_at<=now() THEN
    RAISE EXCEPTION 'This trade estimate has expired. Review an updated estimate and try again.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.trade_estimates(trade_id,quote_id) VALUES(p_trade_id,p_quote_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_trade_offer_atomic(
  p_user_id uuid, p_request_id uuid, p_member_id uuid, p_action text, p_payload jsonb
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member_league uuid;
  v_multi boolean;
  v_league uuid;
  v_season uuid;
  v_recipient uuid;
  v_source uuid;
  v_notes text;
  v_expiration timestamptz;
  v_offer_players uuid[];
  v_request_players uuid[];
  v_offer_picks uuid[];
  v_request_picks uuid[];
  v_offer_faab int;
  v_request_faab int;
  v_participants uuid[];
  v_items jsonb;
  v_envelope jsonb;
  v_receipt private.trade_offer_requests%ROWTYPE;
  v_inserted int;
  v_result uuid;
BEGIN
  IF p_request_id IS NULL OR p_action IS NULL
    OR p_action NOT IN ('propose','propose-multi','edit','edit-multi','counter','counter-multi')
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'A request key, supported offer action, and offer payload are required.' USING ERRCODE='22023';
  END IF;
  SELECT league_id INTO v_member_league FROM league_members
    WHERE id=p_member_id AND user_id=p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.' USING ERRCODE='42501';
  END IF;

  v_multi := p_action LIKE '%-multi';
  v_notes := NULLIF(btrim(p_payload->>'notes'),'');
  v_expiration := (p_payload->>'expiresAt')::timestamptz;
  v_envelope := jsonb_build_object('version',1,'action',p_action,'memberId',p_member_id,
    'notes',v_notes,'expiresAt',v_expiration);
  IF p_payload ? 'rosterPlan' THEN v_envelope := v_envelope||jsonb_build_object('rosterPlan',p_payload->'rosterPlan'); END IF;
  IF p_action IN ('propose','propose-multi') THEN
    v_league := (p_payload->>'leagueId')::uuid;
    v_season := (p_payload->>'leagueSeasonId')::uuid;
    IF v_league IS DISTINCT FROM v_member_league OR v_season IS NULL THEN
      RAISE EXCEPTION 'The offer must use this member''s league and a season.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('leagueId',v_league,'leagueSeasonId',v_season);
    IF NOT v_multi THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  ELSE
    v_source := (p_payload->>'tradeId')::uuid;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'The source trade is required.' USING ERRCODE='22023';
    END IF;
    v_envelope := v_envelope||jsonb_build_object('tradeId',v_source);
    IF NOT v_multi AND p_payload ? 'recipientMemberId' THEN
      v_recipient := (p_payload->>'recipientMemberId')::uuid;
      v_envelope := v_envelope||jsonb_build_object('recipientMemberId',v_recipient);
    END IF;
  END IF;
  IF v_multi THEN
    v_participants := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'participantMemberIds','[]'::jsonb)))::uuid[];
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'fromMemberId',(item->>'fromMemberId')::uuid,'toMemberId',(item->>'toMemberId')::uuid,
      'playerId',(item->>'playerId')::uuid,'pickId',(item->>'pickId')::uuid,
      'faabAmount',COALESCE((item->>'faabAmount')::int,0)) ORDER BY ordinal),'[]'::jsonb)
      INTO v_items FROM jsonb_array_elements(COALESCE(p_payload->'items','[]'::jsonb)) WITH ORDINALITY AS items(item,ordinal);
    v_envelope := v_envelope||jsonb_build_object('participantMemberIds',v_participants,'items',v_items);
  ELSE
    v_offer_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPlayerIds','[]'::jsonb)))::uuid[];
    v_request_players := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPlayerIds','[]'::jsonb)))::uuid[];
    v_offer_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'offerPickIds','[]'::jsonb)))::uuid[];
    v_request_picks := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'requestPickIds','[]'::jsonb)))::uuid[];
    v_offer_faab := COALESCE((p_payload->>'offerFaabAmount')::int,0);
    v_request_faab := COALESCE((p_payload->>'requestFaabAmount')::int,0);
    v_envelope := v_envelope||jsonb_build_object('offerPlayerIds',v_offer_players,'requestPlayerIds',v_request_players,
      'offerPickIds',v_offer_picks,'requestPickIds',v_request_picks,
      'offerFaabAmount',v_offer_faab,'requestFaabAmount',v_request_faab);
  END IF;

  INSERT INTO private.trade_offer_requests(user_id,request_id,member_id,request_payload)
    VALUES(p_user_id,p_request_id,p_member_id,v_envelope) ON CONFLICT(user_id,request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted=ROW_COUNT;
  -- The separate statement sees a concurrent claim after its transaction commits.
  SELECT * INTO STRICT v_receipt FROM private.trade_offer_requests
    WHERE user_id=p_user_id AND request_id=p_request_id FOR UPDATE;
  IF v_receipt.member_id IS DISTINCT FROM p_member_id OR v_receipt.request_payload IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'This request key already belongs to different trade terms.' USING ERRCODE='22023';
  END IF;
  IF v_receipt.completed THEN RETURN v_receipt.result_trade_id; END IF;
  IF v_inserted=0 THEN
    RAISE EXCEPTION 'This trade request has no completed receipt.' USING ERRCODE='55000';
  END IF;

  IF p_action='propose' THEN
    v_result := public.propose_trade_atomic(v_league,v_season,p_member_id,v_recipient,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  ELSIF p_action='propose-multi' THEN
    v_result := public.propose_multi_team_trade_atomic(v_league,v_season,p_member_id,v_participants,v_items,v_notes,v_expiration);
  ELSIF v_multi THEN
    v_result := private.replace_multi_team_trade_offer(v_source,p_member_id,p_user_id,split_part(p_action,'-',1),
      v_participants,v_items,v_notes,v_expiration);
  ELSE
    IF p_payload ? 'recipientMemberId' AND v_recipient IS DISTINCT FROM (
      SELECT CASE WHEN p_action='counter' THEN proposer_member_id ELSE recipient_member_id END
        FROM public.trades WHERE id=v_source AND league_id=v_member_league
    ) THEN
      RAISE EXCEPTION 'The replacement must keep the original counterparty.' USING ERRCODE='22023';
    END IF;
    v_result := private.replace_trade_offer(v_source,p_member_id,p_user_id,p_action,
      v_offer_players,v_request_players,v_offer_picks,v_request_picks,v_notes,v_expiration,v_offer_faab,v_request_faab);
  END IF;
  IF p_payload ? 'rosterPlan' AND v_result IS NOT NULL THEN
    PERFORM public.set_trade_roster_plan_atomic(v_result,p_member_id,p_user_id,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'taxiPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'irPlayerIds'))::uuid[],
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'rosterPlan'->'dropPlayerIds'))::uuid[]);
  END IF;
  IF v_result IS NOT NULL THEN
    PERFORM private.validate_trade_rosters(v_result, p_member_id);
    PERFORM private.attach_trade_estimate(v_result,p_member_id,(p_payload->>'estimateId')::uuid);
  END IF;
  UPDATE private.trade_offer_requests SET completed=true,result_trade_id=v_result
    WHERE user_id=p_user_id AND request_id=p_request_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_trade_estimate_quotes()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE removed integer;
BEGIN
  WITH expired AS (
    SELECT q.id FROM public.trade_estimate_quotes q WHERE q.expires_at<now()-interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM public.trade_estimates e WHERE e.quote_id=q.id)
    ORDER BY q.expires_at,q.id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ) DELETE FROM public.trade_estimate_quotes q USING expired WHERE q.id=expired.id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION private.canonical_trade_estimate_terms(jsonb),private.attach_trade_estimate(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_trade_estimate_inputs(uuid,uuid,jsonb),public.save_trade_estimate_quote(uuid,uuid,jsonb,jsonb,text),public.cleanup_trade_estimate_quotes() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_estimate_inputs(uuid,uuid,jsonb),public.save_trade_estimate_quote(uuid,uuid,jsonb,jsonb,text),public.cleanup_trade_estimate_quotes() TO service_role;
SELECT cron.schedule('cleanup-trade-estimates','35 8 * * *','SELECT public.cleanup_trade_estimate_quotes();');
