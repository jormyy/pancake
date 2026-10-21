BEGIN;
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(v_league,'Synthetic mock timer gap',v_league::text,v_user,'offseason');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2189,true);
  INSERT INTO league_members(id,league_id,user_id,role) VALUES(v_member,v_league,v_user,'commissioner');
  PERFORM public.create_mock_draft_room_atomic(p_league_id=>v_league,p_member_id=>v_member,p_user_id=>v_user,p_draft_type=>'snake',p_pick_timer_seconds=>604800);
END;
$$;
ROLLBACK;
