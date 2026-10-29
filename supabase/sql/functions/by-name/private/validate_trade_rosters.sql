CREATE OR REPLACE FUNCTION private.validate_trade_rosters(p_trade_id uuid,p_only_member_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user uuid; v_teams jsonb; v_error text;
BEGIN
  PERFORM 1 FROM leagues WHERE id=(SELECT league_id FROM trades WHERE id=p_trade_id) FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM players WHERE id IN (
    SELECT player_id FROM trade_items WHERE trade_id=p_trade_id UNION
    SELECT r.player_id FROM roster_players r JOIN trade_participants t ON t.member_id=r.member_id
      JOIN trades trade ON trade.id=t.trade_id AND trade.league_season_id=r.league_season_id WHERE t.trade_id=p_trade_id
  ) ORDER BY id FOR SHARE;
  PERFORM private.ensure_faab_balance(trade.league_id,trade.league_season_id,participant.member_id)
    FROM trades trade JOIN trade_participants participant ON participant.trade_id=trade.id
    WHERE trade.id=p_trade_id ORDER BY participant.sort_order,participant.member_id;
  SELECT m.user_id INTO v_user FROM trades t JOIN league_members m ON m.id=t.proposer_member_id WHERE t.id=p_trade_id;
  v_teams:=public.get_trade_roster_preview(p_trade_id,v_user);
  SELECT string_agg(reason->>'message',' ') INTO v_error FROM jsonb_array_elements(v_teams) team
    CROSS JOIN LATERAL jsonb_array_elements(team->'reasons') reason
    WHERE p_only_member_id IS NULL OR team->>'memberId'=p_only_member_id::text;
  IF v_error IS NOT NULL THEN RAISE EXCEPTION '%',v_error USING ERRCODE='PT409',DETAIL=v_teams::text; END IF;
END;
$$;
