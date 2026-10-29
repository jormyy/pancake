BEGIN;
SET LOCAL session_replication_role=replica;
CREATE TEMP TABLE fixture_trade AS SELECT trade.* FROM public.trades trade
  WHERE league_season_id='95b790d1-ffda-436b-ac7d-875e198dc6d9'
    AND EXISTS(SELECT 1 FROM public.trade_items WHERE trade_id=trade.id AND player_id IS NOT NULL)
  ORDER BY (status='pending') DESC,id LIMIT 1;
CREATE TEMP TABLE fixture_participants AS SELECT participant.* FROM public.trade_participants participant JOIN fixture_trade trade ON trade.id=participant.trade_id;
CREATE TEMP TABLE fixture_items AS SELECT item.* FROM public.trade_items item JOIN fixture_trade trade ON trade.id=item.trade_id;
DELETE FROM public.trade_items WHERE trade_id IN(SELECT id FROM public.trades WHERE league_season_id='95b790d1-ffda-436b-ac7d-875e198dc6d9');
DELETE FROM public.trade_participants WHERE trade_id IN(SELECT id FROM public.trades WHERE league_season_id='95b790d1-ffda-436b-ac7d-875e198dc6d9');
DELETE FROM public.trades WHERE league_season_id='95b790d1-ffda-436b-ac7d-875e198dc6d9';
DO $$
DECLARE added_trade_id uuid; state public.trade_status;
BEGIN
  FOREACH state IN ARRAY ARRAY['pending','pending','pending','pending','pending','pending','pending','pending','pending',
    'accepted','completed','completed','withdrawn','withdrawn','rejected','rejected','countered','countered']::public.trade_status[] LOOP
    INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
      SELECT league_id,league_season_id,proposer_member_id,recipient_member_id,state FROM fixture_trade RETURNING id INTO added_trade_id;
    INSERT INTO public.trade_participants(trade_id,league_id,member_id,proposed_at,sort_order,is_initiator)
      SELECT added_trade_id,league_id,member_id,proposed_at,sort_order,is_initiator FROM fixture_participants;
    INSERT INTO public.trade_items(league_id,trade_id,from_member_id,to_member_id,player_id,pick_id,faab_amount,side)
      SELECT league_id,added_trade_id,from_member_id,to_member_id,player_id,pick_id,faab_amount,side FROM fixture_items;
  END LOOP;
END;
$$;
COMMIT;
ANALYZE;
