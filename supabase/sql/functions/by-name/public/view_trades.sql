CREATE OR REPLACE FUNCTION public.view_trades(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; refs jsonb; rows jsonb; page_size integer := LEAST(GREATEST(COALESCE((p_params->>'limit')::integer, 40), 1), 99);
  has_more boolean; next_cursor jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id, p_params);
  IF COALESCE(p_params->>'tab', 'offers') = 'history' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(ref)), '[]') INTO refs FROM (
      SELECT trade.id AS trade_id, jsonb_build_object('proposedAt', trade.proposed_at, 'tradeId', trade.id)::text AS cursor_token
      FROM public.trade_participants participant JOIN public.trades trade ON trade.id = participant.trade_id
      WHERE participant.league_id = p_league_id AND participant.member_id = p_member_id AND trade.status <> 'pending'
        AND (p_params->>'cursor' IS NULL OR (trade.proposed_at, trade.id) < (
          ((p_params->>'cursor')::jsonb->>'proposedAt')::timestamptz, ((p_params->>'cursor')::jsonb->>'tradeId')::uuid))
      ORDER BY participant.proposed_at DESC, participant.trade_id DESC LIMIT page_size + 1) ref;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(ref)), '[]') INTO refs FROM public.get_trade_page_refs(p_member_id, p_league_id, page_size + 1, p_params->>'cursor') ref;
  END IF;
  has_more := jsonb_array_length(refs) > page_size;
  IF jsonb_array_length(refs)=0 THEN rows:='[]'::jsonb;
  ELSE
  rows := public.get_trade_cards(p_league_id,p_member_id,ARRAY(
    SELECT (ref->>'trade_id')::uuid FROM jsonb_array_elements(refs) WITH ORDINALITY refs(ref,ordinal)
    WHERE ordinal<=page_size ORDER BY ordinal));
  END IF;
  IF has_more THEN next_cursor := jsonb_build_object('token', refs->(page_size - 1)->>'cursor_token'); END IF;
  RETURN jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor,
    'pendingIncomingCount', public.get_pending_trade_count(p_member_id, p_league_id),
    'block', public.view_trade_block(p_league_id, p_member_id, p_params || jsonb_build_object('blockOnly', true))->'block',
    'members', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'team_name', team_name, 'role', role) ORDER BY id)
      FROM public.league_members WHERE league_id = p_league_id), '[]'));
END;
$$;
