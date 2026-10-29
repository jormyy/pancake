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
