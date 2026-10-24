BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_draft public.drafts%ROWTYPE;
  v_seconds int;
  v_at timestamptz;
  v_deadline timestamptz;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data) SELECT id,'authenticated','authenticated',id||'@example.test','{}' FROM unnest(v_users)id;
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(v_league,'Synthetic mock timer',v_league::text,v_users[1],'offseason');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2189,true);
  INSERT INTO league_members(id,league_id,user_id,role) VALUES(v_members[1],v_league,v_users[1],'commissioner'),(v_members[2],v_league,v_users[2],'manager');
  PERFORM pg_sleep(1.1);
  FOREACH v_seconds IN ARRAY ARRAY[60,604800] LOOP
    v_draft := create_mock_draft_room_atomic(p_league_id=>v_league,p_member_id=>v_members[1],p_user_id=>v_users[1],p_draft_type=>'snake',p_pick_timer_seconds=>v_seconds);
    IF v_draft.pick_timer_seconds <> v_seconds THEN RAISE EXCEPTION 'Mock rookie duration changes'; END IF;
    PERFORM join_mock_draft_room_atomic(v_draft.id,v_members[2],v_users[2]);
    v_at := clock_timestamp();
    v_draft := start_mock_draft_room_atomic(v_draft.id,v_members[1],v_users[1]);
    IF v_draft.status <> 'in_progress' THEN RAISE EXCEPTION 'Mock rookie room does not start'; END IF;
    SELECT timer_expires_at INTO v_deadline FROM snake_draft_picks WHERE draft_id=v_draft.id AND overall_pick=1;
    IF v_deadline IS NULL OR extract(epoch FROM v_deadline-v_at) NOT BETWEEN v_seconds-0.1 AND v_seconds+0.5 THEN RAISE EXCEPTION 'Mock rookie timer loses time before arming'; END IF;
    IF (SELECT count(*) FROM snake_draft_picks WHERE draft_id=v_draft.id) <> 6 THEN RAISE EXCEPTION 'Mock rookie pick order changes'; END IF;
  END LOOP;
  v_draft := create_mock_draft_room_atomic(p_league_id=>v_league,p_member_id=>v_members[1],p_user_id=>v_users[1],p_draft_type=>'snake');
  IF v_draft.pick_timer_seconds <> 60 THEN RAISE EXCEPTION 'Mock rookie default must be 60'; END IF;
  v_draft := create_mock_draft_room_atomic(p_league_id=>v_league,p_member_id=>v_members[1],p_user_id=>v_users[1],p_draft_type=>'auction');
  IF v_draft.pick_timer_seconds <> 30 THEN RAISE EXCEPTION 'Auction default must stay 30'; END IF;
  FOREACH v_seconds IN ARRAY ARRAY[5,3600] LOOP
    v_draft := create_mock_draft_room_atomic(p_league_id=>v_league,p_member_id=>v_members[1],p_user_id=>v_users[1],p_draft_type=>'auction',p_pick_timer_seconds=>v_seconds);
    IF v_draft.pick_timer_seconds <> v_seconds THEN RAISE EXCEPTION 'Auction duration changes'; END IF;
  END LOOP;
  FOREACH v_seconds IN ARRAY ARRAY[59,604801] LOOP
    BEGIN
      PERFORM create_mock_draft_room_atomic(p_league_id=>v_league,p_member_id=>v_members[1],p_user_id=>v_users[1],p_draft_type=>'snake',p_pick_timer_seconds=>v_seconds);
      RAISE EXCEPTION 'Mock rookie accepts an invalid timer';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%between 60 and 604800%' THEN RAISE; END IF;
    END;
  END LOOP;
  FOREACH v_seconds IN ARRAY ARRAY[4,3601] LOOP
    BEGIN
      PERFORM create_mock_draft_room_atomic(p_league_id=>v_league,p_member_id=>v_members[1],p_user_id=>v_users[1],p_draft_type=>'auction',p_pick_timer_seconds=>v_seconds);
      RAISE EXCEPTION 'Auction accepts an invalid timer';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE '%between 5 and 3600%' THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;
ROLLBACK;
