BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid; active uuid; claim uuid; result record; reason text; capacity text; old_season uuid; mode text;
BEGIN
  FOREACH mode IN ARRAY ARRAY['ineligible','unknown','full','exit','tenure'] LOOP
    FOREACH capacity IN ARRAY ARRAY['room','drop','blocked'] LOOP
      SELECT * INTO f FROM pg_temp.rules_fixture(2,9547);
      player:=gen_random_uuid(); active:=gen_random_uuid();
      UPDATE leagues SET roster_size=CASE capacity WHEN 'room' THEN 2 ELSE 1 END,
        taxi_slots=CASE mode WHEN 'full' THEN 0 ELSE 2 END,taxi_max_seasons=2 WHERE id=f.league_id;
      INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games)
        VALUES(player,'Fallback',mode,'PG',ARRAY['PG'],1,64),(active,'Active',capacity,'PG',ARRAY['PG'],4,200);
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
        VALUES(f.league_id,f.season_id,f.member_ids[1],active,'draft');
      INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
        VALUES(f.league_id,f.season_id,player,now()-interval '4 days');
      claim:=public.create_waiver_claim_atomic(p_league_id=>f.league_id,p_member_id=>f.member_ids[1],p_player_id=>player,
        p_drop_player_id=>CASE WHEN capacity='drop' THEN active ELSE NULL END,p_user_id=>f.user_ids[1],p_to_taxi=>true);
      IF mode='ineligible' THEN
        UPDATE players SET career_regular_season_games=65 WHERE id=player;
        reason:='fewer than 65';
      ELSIF mode='unknown' THEN
        UPDATE players SET career_regular_season_games=NULL WHERE id=player;
        reason:='not known yet';
      ELSIF mode='full' THEN reason:='taxi squad is full';
      ELSIF mode='exit' THEN
        INSERT INTO league_member_taxi_exits(league_id,member_id,player_id) VALUES(f.league_id,f.member_ids[1],player);
        reason:='cannot return';
      ELSE
        old_season:=gen_random_uuid();
        INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(old_season,f.league_id,9545,false);
        INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type)
          VALUES(f.league_id,old_season,f.member_ids[1],player,'taxi_designate');
        reason:='tenure limit';
      END IF;
      SELECT * INTO result FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date);
      IF capacity='blocked' THEN
        PERFORM pg_temp.check_rules(result.status='failed_roster' AND result.failure_reason ILIKE '%'||reason||'%' AND result.failure_reason ILIKE '%active roster is full%',mode||' unavailable taxi fails with its reason when active roster is full');
        PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=player),mode||' failed claim acquires no player');
      ELSE
        PERFORM pg_temp.check_rules(result.status='succeeded' AND EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=player AND NOT is_on_taxi AND NOT is_on_ir),mode||' falls back to active with '||capacity);
        PERFORM pg_temp.check_rules((capacity='room')=EXISTS(SELECT 1 FROM roster_players WHERE league_id=f.league_id AND player_id=active),mode||' fallback honors the selected drop with '||capacity);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
