BEGIN;
DO $$
DECLARE
  v_users uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_leagues uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_seasons uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_members uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_trades uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()];
  v_picks uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_draft uuid := gen_random_uuid();
  v_mock uuid := gen_random_uuid();
  i int;
  a int;
  b int;
BEGIN
  FOR i IN 1..2 LOOP
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_users[i],'authenticated','authenticated',v_users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  FOR i IN 1..2 LOOP
    a := i*2-1;
    b := i*2;
    INSERT INTO leagues(id,name,slug,commissioner_id,status)
    VALUES(v_leagues[i],'Reset Queue '||i,v_leagues[i]::text,v_users[1],'active');
    INSERT INTO league_seasons(id,league_id,season_year,is_current)
    VALUES(v_seasons[i],v_leagues[i],2111,true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(v_members[a],v_leagues[i],v_users[1],'commissioner','A'),(v_members[b],v_leagues[i],v_users[2],'manager','B');
    INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(v_picks[a],v_leagues[i],2112,1,v_members[a],v_members[a]),(v_picks[b],v_leagues[i],2112,1,v_members[b],v_members[b]);
    INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,accepted_at,veto_window_expires_at)
    VALUES(v_trades[i],v_leagues[i],v_seasons[i],v_members[a],v_members[b],'accepted',now()-interval '3 hours',now()-i*interval '1 hour');
    INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
    VALUES(v_trades[i],v_members[a],0,true,now()),(v_trades[i],v_members[b],1,false,now());
    INSERT INTO trade_items(trade_id,side,pick_id,from_member_id,to_member_id)
    VALUES(v_trades[i],'proposer',v_picks[a],v_members[a],v_members[b]),(v_trades[i],'recipient',v_picks[b],v_members[b],v_members[a]);
  END LOOP;
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(v_draft,v_leagues[1],v_seasons[1],'snake','completed',false,1),
        (v_mock,v_leagues[1],v_seasons[1],'snake','completed',true,1);
  BEGIN
    PERFORM reset_draft_atomic(v_draft,v_users[1]);
    RAISE EXCEPTION 'Reset strands accepted trades';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Resolve accepted trades before resetting the draft.' THEN RAISE; END IF;
  END;
  IF (SELECT status FROM leagues WHERE id=v_leagues[1]) <> 'active'
     OR (SELECT status FROM drafts WHERE id=v_draft) <> 'completed' THEN
    RAISE EXCEPTION 'Rejected reset changes league or draft';
  END IF;
  PERFORM reset_draft_atomic(v_mock,v_users[1]);

  UPDATE leagues SET status='drafting' WHERE id=v_leagues[1];
  PERFORM process_due_accepted_trades_atomic(50);
  IF (SELECT status FROM trades WHERE id=v_trades[1]) <> 'completed'
     OR (SELECT status FROM trades WHERE id=v_trades[2]) <> 'completed'
     OR (SELECT current_owner_id FROM draft_picks WHERE id=v_picks[3]) <> v_members[4] THEN
    RAISE EXCEPTION 'Drafting and active leagues must settle their due trades together';
  END IF;
  UPDATE leagues SET status='active' WHERE id=v_leagues[1];
  PERFORM process_due_accepted_trades_atomic(50);
  IF (SELECT status FROM trades WHERE id=v_trades[1]) <> 'completed'
     OR (SELECT current_owner_id FROM draft_picks WHERE id=v_picks[1]) <> v_members[2] THEN
    RAISE EXCEPTION 'A settled drafting trade must stay settled after activation';
  END IF;
  PERFORM reset_draft_atomic(v_draft,v_users[1]);
  IF (SELECT status FROM leagues WHERE id=v_leagues[1]) <> 'drafting' THEN
    RAISE EXCEPTION 'Reset remains blocked after accepted trades settle';
  END IF;
END;
$$;
ROLLBACK;
