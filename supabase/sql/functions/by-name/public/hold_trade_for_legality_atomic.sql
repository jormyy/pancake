-- Canonical SQL source for public.hold_trade_for_legality_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.hold_trade_for_legality_atomic(p_trade_id uuid,p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_trade trades%ROWTYPE; v_teams jsonb; v_reasons jsonb; v_message text;
BEGIN
  SELECT * INTO STRICT v_trade FROM trades WHERE id=p_trade_id AND status='accepted' FOR UPDATE;
  SELECT public.get_trade_roster_preview(p_trade_id,user_id) INTO v_teams FROM league_members WHERE id=v_trade.proposer_member_id;
  SELECT COALESCE(jsonb_agg(reason),'[]'),string_agg(reason->>'message',' ') INTO v_reasons,v_message
    FROM jsonb_array_elements(v_teams) team CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason;
  IF jsonb_array_length(v_reasons)=0 THEN
    v_message:=COALESCE(p_reason,'Review this trade before execution.');
    v_reasons:=jsonb_build_array(jsonb_build_object('rule','execution','message',v_message,'suggestedMoves','[]'::jsonb));
  END IF;
  UPDATE trades SET legality_issues=v_reasons,completion_failure_reason=v_message WHERE id=p_trade_id;
  INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT format('trade_attention:%s:%s:%s',p_trade_id,member_id,md5(v_reasons::text)),member_id,'trade_needs_attention','Trade needs attention',
    v_message,jsonb_build_object('tradeId',p_trade_id,'reasons',v_reasons),'trade'
    FROM trade_participants WHERE trade_id=p_trade_id ON CONFLICT(dedupe_key) DO NOTHING;
END;
$$;
