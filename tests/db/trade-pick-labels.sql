BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE pick_fixture AS SELECT * FROM pg_temp.rules_fixture(3,2027,'offseason');
CREATE TEMP TABLE pick_trade (id uuid);
GRANT SELECT ON pick_fixture,pick_trade TO authenticated;
DO $$
DECLARE f record; picks uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()]; offer uuid;
BEGIN
  SELECT * INTO f FROM pick_fixture;
  UPDATE league_members SET team_name=CASE id WHEN f.member_ids[1] THEN 'Matthew' WHEN f.member_ids[2] THEN 'Mike' ELSE 'Justin' END WHERE league_id=f.league_id;
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
  VALUES(picks[1],f.league_id,2028,1,f.member_ids[3],f.member_ids[2]),(picks[2],f.league_id,2029,2,f.member_ids[2],f.member_ids[2]);
  offer:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}',picks,NULL,NULL,1,0);
  INSERT INTO pick_trade VALUES(offer);
END;
$$;
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM pick_fixture),true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_league_activity_feed((SELECT league_id FROM pick_fixture)) WHERE transaction_type='trade_offered'),'pending offers stay private');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT public.accept_trade_atomic((SELECT id FROM pick_trade),(SELECT member_ids[2] FROM pick_fixture));
UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=(SELECT id FROM pick_trade);
SELECT public.complete_accepted_trade_atomic((SELECT id FROM pick_trade));
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM pick_fixture),true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_rules(jsonb_array_length(trade_picks)=2,'completed activity includes both picks')
FROM public.get_league_activity_feed((SELECT league_id FROM pick_fixture)) WHERE transaction_type='trade_completed';
SELECT pg_temp.check_rules(
  (SELECT bool_and(pick->>'fromMemberId'=(SELECT member_ids[2]::text FROM pick_fixture) AND pick->>'toMemberId'=(SELECT member_ids[1]::text FROM pick_fixture)) FROM jsonb_array_elements(trade_picks) pick),
  'activity keeps sender and recipient after ownership changes')
FROM public.get_league_activity_feed((SELECT league_id FROM pick_fixture)) WHERE transaction_type='trade_completed';
SELECT pg_temp.check_rules(
  (SELECT pick->>'originalTeamName'='Justin' AND pick->>'fromTeamName'='Mike' AND pick->>'toTeamName'='Matthew' FROM jsonb_array_elements(trade_picks) pick WHERE pick->>'round'='1'),
  'original team stays distinct from sender')
FROM public.get_league_activity_feed((SELECT league_id FROM pick_fixture)) WHERE transaction_type='trade_completed';
SELECT pg_temp.check_rules(
  EXISTS(SELECT 1 FROM jsonb_array_elements(public.view_activity((SELECT league_id FROM pick_fixture),(SELECT member_ids[1] FROM pick_fixture))->'rows') row WHERE jsonb_array_length(row->'tradePicks')=2),
  'screen reader preserves both pick routes');
SELECT pg_temp.reject_rules(format('SELECT * FROM public.get_league_activity_feed(%L::uuid)',gen_random_uuid()),'Access denied.','nonmembers cannot read pick routes');
RESET ROLE;
SELECT pg_temp.check_rules((SELECT count(*) FROM rules_checks)=6,'all six feed assertions execute');
SELECT count(*) AS passed FROM rules_checks;
ROLLBACK;
