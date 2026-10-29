BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  p uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_trade_id uuid;
  retained_ir jsonb;
  error_code text;
  error_detail text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9661);
  UPDATE leagues SET roster_size=3, ir_slots=2, taxi_slots=2, allow_inactive_trades=true, trade_veto_mode='commissioner', trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
    SELECT id,'Taxi policy','Player '||n,'PG',ARRAY['PG'],0,0,'Out' FROM unnest(p) WITH ORDINALITY ids(id,n);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN n<3 THEN 1 ELSE 2 END],id,'draft'
    FROM unnest(p) WITH ORDINALITY ids(id,n);
  v_trade_id := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[p[1]],ARRAY[p[3]],'{}','{}');
  retained_ir := jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','ir'));
  PERFORM public.set_trade_roster_plan_atomic(v_trade_id,f.member_ids[1],f.user_ids[1],ARRAY[p[3]],'{}','{}',retained_ir);
  PERFORM pg_temp.check_rules((SELECT to_taxi FROM trade_items WHERE trade_items.trade_id=v_trade_id AND player_id=p[3]),'eligible incoming player can use Taxi');
  PERFORM pg_temp.check_rules((SELECT roster_moves=retained_ir FROM trade_participants WHERE trade_participants.trade_id=v_trade_id AND member_id=f.member_ids[1]),'eligible retained player can use IR');
  PERFORM pg_temp.reject_rules(format('SELECT public.set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L,%L::jsonb)',
    v_trade_id,f.member_ids[1],f.user_ids[1],ARRAY[p[3]],'{}','{}',jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','taxi'))),
    '%incoming%', 'existing rookie cannot enter Taxi through a saved trade move');
  PERFORM pg_temp.check_rules((SELECT roster_moves=retained_ir FROM trade_participants WHERE trade_participants.trade_id=v_trade_id AND member_id=f.member_ids[1]),'rejected Taxi move preserves the saved plan');
  BEGIN
    PERFORM public.set_trade_roster_plan_atomic(v_trade_id,f.member_ids[1],f.user_ids[1],'{}','{}','{}',jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','taxi')));
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS error_code=RETURNED_SQLSTATE,error_detail=PG_EXCEPTION_DETAIL;
  END;
  PERFORM pg_temp.check_rules(error_code='PT422' AND error_detail='TRADE_TAXI_INCOMING_ONLY','retained Taxi rejection has a stable error code');
  UPDATE players SET years_exp=3,career_regular_season_games=64 WHERE id=p[3];
  PERFORM public.set_trade_roster_plan_atomic(v_trade_id,f.member_ids[1],f.user_ids[1],ARRAY[p[3]],'{}','{}',retained_ir);
  PERFORM pg_temp.check_rules((SELECT to_taxi FROM trade_items WHERE trade_items.trade_id=v_trade_id AND player_id=p[3]),'incoming player with 64 career games can use Taxi');
  UPDATE players SET career_regular_season_games=65 WHERE id=p[3];
  PERFORM pg_temp.reject_rules(format('SELECT public.set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L,%L::jsonb)',
    v_trade_id,f.member_ids[1],f.user_ids[1],ARRAY[p[3]],'{}','{}',retained_ir),'%Taxi requires%','incoming player with 65 games is rejected at save');
  UPDATE players SET career_regular_season_games=NULL WHERE id=p[3];
  PERFORM pg_temp.reject_rules(format('SELECT public.set_trade_roster_plan_atomic(%L,%L,%L,%L,%L,%L,%L::jsonb)',
    v_trade_id,f.member_ids[1],f.user_ids[1],ARRAY[p[3]],'{}','{}',retained_ir),'%Taxi requires%','incoming veteran with unknown games is rejected at save');
  UPDATE players SET years_exp=0 WHERE id=p[3];
  PERFORM public.set_trade_roster_plan_atomic(v_trade_id,f.member_ids[1],f.user_ids[1],ARRAY[p[3]],'{}','{}',retained_ir);
  PERFORM pg_temp.check_rules((SELECT to_taxi FROM trade_items WHERE trade_items.trade_id=v_trade_id AND player_id=p[3]),'incoming rookie with unknown games can use Taxi');
  PERFORM public.accept_trade_with_plan_atomic(v_trade_id,f.member_ids[2],f.user_ids[2],'{}','{}','{}');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=v_trade_id;
  UPDATE trade_participants SET roster_moves=jsonb_build_array(jsonb_build_object('playerId',p[2],'destination','taxi')) WHERE trade_id=v_trade_id AND member_id=f.member_ids[1];
  PERFORM pg_temp.check_rules((public.get_trade_roster_preview(v_trade_id,f.user_ids[1])->0->'reasons') @> '[{"rule":"taxi_incoming_only"}]','legacy retained Taxi move fails preview');
  error_code:=NULL;error_detail:=NULL;
  BEGIN
    PERFORM public.complete_accepted_trade_atomic(v_trade_id);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS error_code=RETURNED_SQLSTATE,error_detail=PG_EXCEPTION_DETAIL;
  END;
  PERFORM pg_temp.check_rules(error_code='PT422' AND error_detail='TRADE_TAXI_INCOMING_ONLY','execution rejects legacy retained Taxi with the stable code');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE player_id=p[3]),'rejected execution transfers no players');
  UPDATE trade_participants SET roster_moves=retained_ir WHERE trade_id=v_trade_id AND member_id=f.member_ids[1];
  UPDATE players SET years_exp=3,career_regular_season_games=65 WHERE id=p[3];
  PERFORM public.complete_accepted_trade_atomic(v_trade_id);
  PERFORM pg_temp.check_rules((SELECT status='accepted' AND legality_issues @> '[{"rule":"taxi_eligibility"}]' FROM trades WHERE id=v_trade_id),'execution rechecks incoming Taxi eligibility');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE player_id=p[3]),'ineligible execution transfers no players');
  UPDATE players SET career_regular_season_games=64 WHERE id=p[3];
  PERFORM public.complete_accepted_trade_atomic(v_trade_id);
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=v_trade_id),'eligible repaired trade completes');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] AND is_on_taxi FROM roster_players WHERE player_id=p[3]),'eligible incoming player arrives on Taxi');

END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
