BEGIN;
SET LOCAL statement_timeout='30s';
CREATE FUNCTION pg_temp.assert_pick_cleanup(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
CREATE TEMP TABLE pick_cleanup_fixture(league_id uuid, protected_ids uuid[], extra_ids uuid[]);
CREATE TABLE public.pick_window_test_reference(pick_id uuid REFERENCES public.draft_picks(id) ON DELETE CASCADE);
DO $$
DECLARE
  league uuid := gen_random_uuid();
  season uuid := gen_random_uuid();
  draft uuid := gen_random_uuid();
  users uuid[] := '{}';
  members uuid[] := '{}';
  protected uuid[] := '{}';
  extras uuid[];
  pick uuid;
  trade uuid := gen_random_uuid();
  i int;
BEGIN
  FOR i IN 1..7 LOOP
    users := array_append(users,gen_random_uuid());
    members := array_append(members,gen_random_uuid());
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  INSERT INTO leagues(id,name,slug,commissioner_id,status,future_pick_years) VALUES(league,'Pick cleanup',league::text,users[1],'setup',5);
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,2027,true);
  FOR i IN 1..7 LOOP
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i);
  END LOOP;
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT league,y,r,m,m FROM generate_series(2028,2034) y CROSS JOIN generate_series(1,3) r CROSS JOIN unnest(members) m;
  SELECT array_agg(id) INTO extras FROM draft_picks WHERE league_id=league AND season_year>2032;
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock) VALUES(draft,league,season,'snake','pending',false);
  FOR i IN 1..8 LOOP
    INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id,is_used,used_at,rookie_draft_id)
    VALUES(league,2034+i,1,members[1],members[1],i=1,CASE WHEN i=2 THEN now() END,CASE WHEN i=3 THEN draft END)
    RETURNING id INTO pick;
    protected := array_append(protected,pick);
  END LOOP;
  INSERT INTO trade_block_items(league_id,member_id,pick_id) VALUES(league,members[1],protected[4]);
  INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status)
  VALUES(trade,league,season,members[1],members[2],'pending');
  INSERT INTO trade_items(trade_id,side,pick_id,from_member_id,to_member_id)
  VALUES(trade,'proposer',protected[5],members[1],members[2]);
  INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,draft_pick_id)
  VALUES(draft,1,1,1,members[1],protected[6]);
  INSERT INTO public.pick_window_test_reference VALUES(protected[7]);
  PERFORM private.log_league_activity(league,season,'trade_block_updated','Trade block updated',p_metadata=>jsonb_build_object('pick_id',protected[8]));
  INSERT INTO pick_cleanup_fixture VALUES(league,protected,extras);
END;
$$;
SELECT private.reconcile_future_picks(league_id) FROM pick_cleanup_fixture;
SELECT pg_temp.assert_pick_cleanup((SELECT count(*)=0 FROM draft_picks WHERE id=ANY((SELECT extra_ids FROM pick_cleanup_fixture)::uuid[])),
  'cleanup removes all 42 unused distant picks');
SELECT pg_temp.assert_pick_cleanup((SELECT count(*)=105 AND min(season_year)=2028 AND max(season_year)=2032 FROM draft_picks
  WHERE league_id=(SELECT league_id FROM pick_cleanup_fixture) AND season_year<=2032),'cleanup keeps the five owned future drafts');
SELECT pg_temp.assert_pick_cleanup((SELECT count(*)=8 FROM draft_picks WHERE id=ANY((SELECT protected_ids FROM pick_cleanup_fixture)::uuid[])),
  'cleanup keeps used picks, assignments, trade references, draft slots, activity references, and every foreign key');
SELECT pg_temp.assert_pick_cleanup((SELECT count(*)=1 FROM public.pick_window_test_reference),'cleanup never cascades a reference deletion');
CREATE TEMP TABLE pick_cleanup_after AS SELECT id FROM draft_picks WHERE league_id=(SELECT league_id FROM pick_cleanup_fixture);
SELECT private.reconcile_future_picks(league_id) FROM pick_cleanup_fixture;
SELECT pg_temp.assert_pick_cleanup(NOT EXISTS(SELECT id FROM pick_cleanup_after EXCEPT SELECT id FROM draft_picks)
  AND (SELECT count(*) FROM draft_picks WHERE league_id=(SELECT league_id FROM pick_cleanup_fixture))=(SELECT count(*) FROM pick_cleanup_after),
  'cleanup is idempotent');
ROLLBACK;
