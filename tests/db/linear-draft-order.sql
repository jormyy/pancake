BEGIN;
DO $$
DECLARE owner uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); draft uuid; snake uuid; room uuid; actual uuid; original jsonb;
BEGIN
 INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[owner,other]) id;
 INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_entrants,playoff_round_lengths)
 VALUES(league,'Linear draft',league::text,owner,'offseason',2,ARRAY[1]);
 INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(owner,league,owner,'commissioner','First'),(other,league,other,'manager','Second');
 INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,2128,true);
 PERFORM set_config('request.jwt.claim.sub',owner::text,true);
 draft:=(public.start_rookie_draft_atomic(league,3,true)->>'id')::uuid;
 IF EXISTS(SELECT 1 FROM snake_draft_picks a JOIN snake_draft_picks b ON b.draft_id=a.draft_id AND b.pick_in_round=a.pick_in_round WHERE a.draft_id=draft AND a.member_id<>b.member_id) THEN
  RAISE EXCEPTION 'Default rookie draft changes slots between rounds';
 END IF;
 SELECT jsonb_agg(jsonb_build_array(member_id,position) ORDER BY position) INTO original FROM draft_orders WHERE draft_id=draft;
 DELETE FROM draft_orders WHERE draft_id=draft;
 PERFORM public.generate_linear_draft_order(draft);
 IF original IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_array(member_id,position) ORDER BY position) FROM draft_orders WHERE draft_id=draft) THEN
  RAISE EXCEPTION 'Stored seed does not reproduce the draft order';
 END IF;
 UPDATE leagues SET rookie_draft_order='snake' WHERE id=league;
 snake:=(public.start_rookie_draft_atomic(league,3,true)->>'id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM snake_draft_picks a JOIN snake_draft_picks b ON b.draft_id=a.draft_id AND b.pick_in_round=a.pick_in_round AND a.round=1 AND b.round=2 WHERE a.draft_id=snake AND a.member_id<>b.member_id) THEN
  RAISE EXCEPTION 'Snake option does not reverse the second round';
 END IF;
 UPDATE leagues SET rookie_draft_order='linear' WHERE id=league;
 SELECT (public.create_mock_draft_room_atomic(league,owner,owner,p_draft_type:='snake')).id INTO room;
 PERFORM public.join_mock_draft_room_atomic(room,other,other);
 PERFORM public.start_mock_draft_room_atomic(room,owner,owner);
 IF EXISTS(SELECT 1 FROM snake_draft_picks a JOIN snake_draft_picks b ON b.draft_id=a.draft_id AND b.pick_in_round=a.pick_in_round WHERE a.draft_id=room AND a.member_id<>b.member_id) THEN
  RAISE EXCEPTION 'Mock rookie room ignores linear order';
 END IF;
 INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
 SELECT league,2128,r,m,m FROM generate_series(1,3) r CROSS JOIN unnest(ARRAY[owner,other]) m
 WHERE NOT EXISTS(SELECT 1 FROM draft_picks p WHERE p.league_id=league AND p.season_year=2128 AND p.round=r AND p.original_owner_id=m);
 UPDATE draft_picks SET current_owner_id=other WHERE league_id=league AND season_year=2128 AND round=2 AND original_owner_id=owner;
 actual:=(public.start_rookie_draft_atomic(league,3,false)->>'id')::uuid;
 PERFORM public.reseed_rookie_draft_picks_atomic(actual);
 IF EXISTS(SELECT 1 FROM snake_draft_picks p JOIN draft_picks asset ON asset.id=p.draft_pick_id JOIN draft_orders o ON o.draft_id=p.draft_id AND o.member_id=asset.original_owner_id
 WHERE p.draft_id=actual AND (p.pick_in_round<>o.position OR p.member_id<>asset.current_owner_id)) THEN
  RAISE EXCEPTION 'Real draft or reseeding moves original slots or loses traded ownership';
 END IF;
END;
$$;
ROLLBACK;
