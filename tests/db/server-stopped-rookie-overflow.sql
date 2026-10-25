BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; draft uuid; player uuid; active uuid; chosen uuid; game uuid; mode text;
BEGIN
  FOREACH mode IN ARRAY ARRAY['trim','deadline'] LOOP
    PERFORM set_config('request.jwt.claim.sub','',true);
    SELECT * INTO f FROM pg_temp.rules_fixture(2,9556,'offseason');
    player:=gen_random_uuid(); active:=gen_random_uuid(); game:=gen_random_uuid();
    UPDATE leagues SET roster_size=1,taxi_slots=0 WHERE id=f.league_id;
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(game,'0029556001',9556,1,(now() AT TIME ZONE 'America/New_York')::date+1,'STX','STY','Scheduled');
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
      VALUES(player,'Stopped','Rookie','PG',ARRAY['PG'],0,1),(active,'Existing','Veteran','PG',ARRAY['PG'],3,NULL);
    INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
      SELECT f.league_id,9556,1,m,m FROM unnest(f.member_ids) m;
    draft:=(public.start_rookie_draft_atomic(f.league_id,1,false)->>'id')::uuid;
    SELECT member_id INTO chosen FROM snake_draft_picks WHERE draft_id=draft ORDER BY overall_pick LIMIT 1;
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(f.league_id,f.season_id,chosen,active,'draft');
    PERFORM public.make_snake_pick_atomic(draft,chosen,player);
    PERFORM public.stop_draft_atomic(draft,f.user_ids[1]);
    PERFORM pg_temp.check_rules((SELECT status='cancelled' FROM drafts WHERE id=draft),'stop cancels an overflowing rookie draft: '||mode);
    PERFORM pg_temp.check_rules((SELECT status='drafting' FROM leagues WHERE id=f.league_id),'stop keeps the overflowing league drafting: '||mode);
    PERFORM pg_temp.check_rules(NOT public.activate_rookie_draft_league_atomic(p_draft_id=>draft),'cancelled draft waits for trim or deadline: '||mode);
    IF mode='trim' THEN
      PERFORM set_config('request.jwt.claim.sub',(SELECT user_id::text FROM league_members WHERE id=chosen),true);
      PERFORM public.drop_player_atomic((SELECT id FROM roster_players WHERE league_id=f.league_id AND player_id=active),f.season_id,draft);
    ELSE
      UPDATE nba_games SET game_date=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE id=game;
      PERFORM pg_temp.check_rules(public.activate_rookie_draft_league_atomic(p_draft_id=>draft),'cancelled draft activates at the opening-night deadline');
    END IF;
    PERFORM pg_temp.check_rules((SELECT status='active' FROM leagues WHERE id=f.league_id),'stopped league later activates: '||mode);
    DELETE FROM nba_games WHERE id=game;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
