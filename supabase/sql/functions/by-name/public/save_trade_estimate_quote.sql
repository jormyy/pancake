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
