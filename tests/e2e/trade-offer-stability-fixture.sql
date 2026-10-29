\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.league_members SET team_name='Every kingdom needs its Castle' WHERE id='f88efcab-64d5-4d03-a181-4e6dd54eb1cd';
INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,notes,expires_at)
SELECT '8bb264f6-952f-4eea-96c6-3908eb6b178a',league_id,id,'f88efcab-64d5-4d03-a181-4e6dd54eb1cd','e8220878-af71-47e1-883e-46251bea6057','pending','Local offer stability check',now()+interval '7 days'
FROM public.league_seasons WHERE league_id='faab8d8f-6a60-4bbc-8f5d-44050b652cdd' AND is_current ON CONFLICT(id) DO NOTHING;
INSERT INTO public.trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at,league_id,proposed_at)
SELECT id,proposer_member_id,0,true,proposed_at,league_id,proposed_at FROM public.trades WHERE id='8bb264f6-952f-4eea-96c6-3908eb6b178a'
UNION ALL SELECT id,recipient_member_id,1,false,NULL,league_id,proposed_at FROM public.trades WHERE id='8bb264f6-952f-4eea-96c6-3908eb6b178a'
ON CONFLICT DO NOTHING;
INSERT INTO public.trade_items(trade_id,side,player_id,from_member_id,to_member_id,league_id)
SELECT t.id,'proposer',r.player_id,t.proposer_member_id,t.recipient_member_id,t.league_id FROM public.trades t
JOIN LATERAL (SELECT player_id FROM public.roster_players WHERE member_id=t.proposer_member_id AND league_season_id=t.league_season_id AND is_on_ir AND NOT is_on_taxi ORDER BY player_id LIMIT 1) r ON true
WHERE t.id='8bb264f6-952f-4eea-96c6-3908eb6b178a' AND NOT EXISTS(SELECT 1 FROM public.trade_items WHERE trade_id=t.id AND side='proposer');
INSERT INTO public.trade_items(trade_id,side,player_id,from_member_id,to_member_id,league_id)
SELECT t.id,'recipient',r.player_id,t.recipient_member_id,t.proposer_member_id,t.league_id FROM public.trades t
JOIN LATERAL (SELECT player_id FROM public.roster_players WHERE member_id=t.recipient_member_id AND league_season_id=t.league_season_id AND NOT is_on_ir AND NOT is_on_taxi ORDER BY player_id LIMIT 1) r ON true
WHERE t.id='8bb264f6-952f-4eea-96c6-3908eb6b178a' AND NOT EXISTS(SELECT 1 FROM public.trade_items WHERE trade_id=t.id AND side='recipient');
COMMIT;
