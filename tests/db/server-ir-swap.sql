BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; ids uuid[]; rosters uuid[]; variant text; n int;
BEGIN
  FOREACH variant IN ARRAY ARRAY['overflow','lineup'] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(1, 9530);
    UPDATE leagues SET roster_size=1,ir_slots=2 WHERE id=f.league_id;
    ids:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
    rosters:='{}';
    FOR n IN 1..3 LOOP
      INSERT INTO players(id,first_name,last_name,position,eligible_positions,injury_status)
        VALUES(ids[n],'Swap',ids[n]::text,'PG',ARRAY['PG'],'Out');
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
        VALUES(f.league_id,f.season_id,f.member_ids[1],ids[n],'draft',n>1);
      rosters:=array_append(rosters,(SELECT id FROM roster_players WHERE player_id=ids[n]));
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
    IF variant='overflow' THEN
      PERFORM public.activate_roster_player_with_overflow_atomic(
        p_activate_roster_player_id=>rosters[2],p_activate_source=>'ir',p_free_roster_player_id=>rosters[1],p_free_action=>'ir');
    ELSE
      PERFORM public.activate_roster_player_with_lineup_atomic(
        p_activate_roster_player_id=>rosters[2],p_activate_source=>'ir',p_free_roster_player_id=>rosters[1],p_free_action=>'ir',
        p_member_id=>f.member_ids[1],p_league_id=>f.league_id,p_league_season_id=>f.season_id,
        p_game_date=>current_date,p_week_number=>1,p_slot_type=>'BE');
    END IF;
    PERFORM pg_temp.check_rules((SELECT count(*) FILTER(WHERE is_on_ir)=2 AND count(*) FILTER(WHERE NOT is_on_ir AND NOT is_on_taxi)=1
      FROM roster_players WHERE member_id=f.member_ids[1]),variant||' preserves full IR and active capacities');
    PERFORM pg_temp.check_rules((SELECT NOT is_on_ir FROM roster_players WHERE id=rosters[2])
      AND (SELECT is_on_ir FROM roster_players WHERE id=rosters[1]),variant||' swaps the selected players');
    PERFORM pg_temp.check_rules((SELECT count(*)=2 AND count(*) FILTER(WHERE transaction_type='ir_return')=1
      AND count(*) FILTER(WHERE transaction_type='ir_designate')=1 FROM roster_transactions WHERE member_id=f.member_ids[1]),
      variant||' writes both roster transactions');
    PERFORM set_config('request.jwt.claim.sub','',true);
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
