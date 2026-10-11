BEGIN;
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_old uuid := gen_random_uuid();
  v_current uuid := gen_random_uuid();
  v_draft uuid := gen_random_uuid();
  v_player uuid := gen_random_uuid();
  v_mock uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
  VALUES(v_league,'Historical Draft Reset',v_league::text,v_user,'active');
  INSERT INTO league_members(id,league_id,user_id,role,team_name)
  VALUES(v_member,v_league,v_user,'commissioner','Reset Team');
  INSERT INTO league_seasons(id,league_id,season_year,is_current)
  VALUES(v_old,v_league,2108,false),(v_current,v_league,2109,true);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp)
  VALUES(v_player,'Reset','Player','PG',ARRAY['PG'],0);
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(v_draft,v_league,v_old,'snake','completed',false,1),
        (v_mock,v_league,v_old,'snake','completed',true,1);
  INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,player_id,picked_at)
  VALUES(v_draft,1,1,1,v_member,v_player,now());
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(v_league,v_old,v_member,v_player,'draft'),(v_league,v_current,v_member,v_player,'carry_over');
  BEGIN
    PERFORM reset_draft_atomic(v_draft,v_user);
    RAISE EXCEPTION 'Historical draft reset incorrectly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Only current season drafts can be reset.' THEN RAISE; END IF;
  END;
  IF (SELECT status FROM leagues WHERE id=v_league) <> 'active'
     OR (SELECT count(*) FROM roster_players WHERE league_id=v_league) <> 2
     OR NOT EXISTS(SELECT 1 FROM snake_draft_picks WHERE draft_id=v_draft AND player_id=v_player)
     OR (SELECT status FROM drafts WHERE id=v_draft) <> 'completed' THEN
    RAISE EXCEPTION 'Rejected historical reset changes season history or current league state';
  END IF;
  PERFORM reset_draft_atomic(v_mock,v_user);
  IF (SELECT status FROM leagues WHERE id=v_league) <> 'active' THEN
    RAISE EXCEPTION 'Mock reset changes real league status';
  END IF;
  UPDATE league_seasons SET is_current=false WHERE id=v_current;
  UPDATE league_seasons SET is_current=true WHERE id=v_old;
  PERFORM reset_draft_atomic(v_draft,v_user);
  IF (SELECT status FROM leagues WHERE id=v_league) <> 'drafting'
     OR EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=v_old)
     OR NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=v_current AND player_id=v_player)
     OR EXISTS(SELECT 1 FROM snake_draft_picks WHERE draft_id=v_draft AND player_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Current real draft reset no longer resets only its own season';
  END IF;
END;
$$;
ROLLBACK;
