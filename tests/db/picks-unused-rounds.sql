BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $$
#variable_conflict use_variable
<<unused_picks>>
DECLARE
  league uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); users uuid[]:='{}'; members uuid[]:='{}';
  draft_id uuid; selected_member uuid; player uuid; offer uuid; offered uuid; requested uuid;
  original_offered uuid; original_requested uuid; current_season uuid; next_year int;
  i int; result jsonb; phase text; previous_snapshot jsonb;
BEGIN
  FOR i IN 1..4 LOOP
    users:=array_append(users,gen_random_uuid()); members:=array_append(members,gen_random_uuid());
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
    IF i=1 THEN
      INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'Synthetic unused pick classes',league::text,users[1],'offseason');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,8850,true);
    END IF;
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
    VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i);
  END LOOP;
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT league,y,r,m,m FROM generate_series(8850,8855) y CROSS JOIN generate_series(1,3) r CROSS JOIN unnest(members) m;
  result:=start_rookie_draft_atomic(league,2,false); draft_id:=(result->>'id')::uuid;
  FOR i IN 1..8 LOOP
    player:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    VALUES(player,'Synthetic','Unused rounds '||player,'PG',ARRAY['PG'],0,i);
    SELECT member_id INTO selected_member FROM snake_draft_picks pick WHERE pick.draft_id=unused_picks.draft_id AND player_id IS NULL ORDER BY overall_pick LIMIT 1;
    PERFORM make_snake_pick_atomic(draft_id,selected_member,player);
  END LOOP;
  IF (SELECT status FROM drafts WHERE id=draft_id)<>'completed' OR
    (SELECT count(*) FROM draft_picks WHERE league_id=league AND season_year=8850 AND is_used)<>8 OR
    (SELECT count(*) FROM draft_picks WHERE league_id=league AND season_year=8850 AND round=3 AND NOT is_used)<>4 THEN
    RAISE EXCEPTION 'A two-round draft must leave four undrafted round-three assets in this observed policy';
  END IF;
  current_season:=season;
  FOREACH phase IN ARRAY ARRAY['after-two-round-draft','after-year-passes'] LOOP
    IF phase='after-year-passes' THEN
      UPDATE leagues SET status='playoffs' WHERE id=league;
      SELECT a.new_season_id,a.new_year INTO current_season,next_year FROM advance_season_atomic(league) a;
      IF next_year<>8851 THEN RAISE EXCEPTION 'Fixture must cross to the next pick class'; END IF;
    END IF;
    SELECT id INTO offered FROM draft_picks WHERE league_id=league AND season_year=8850 AND round=3 AND current_owner_id=members[1];
    SELECT id INTO requested FROM draft_picks WHERE league_id=league AND season_year=8850 AND round=3 AND current_owner_id=members[2];
    IF offered IS NULL OR requested IS NULL THEN RAISE EXCEPTION 'Both old-class assets must remain present'; END IF;
    SELECT original_owner_id INTO original_offered FROM draft_picks WHERE id=offered;
    SELECT original_owner_id INTO original_requested FROM draft_picks WHERE id=requested;
    offer:=propose_trade_atomic(league,current_season,members[1],members[2],'{}','{}',ARRAY[offered],ARRAY[requested]);
    IF (SELECT status FROM trades WHERE id=offer)<>'pending' THEN RAISE EXCEPTION 'The observed offer must become pending'; END IF;
    PERFORM accept_trade_atomic(offer,members[2]);
    IF (SELECT status FROM trades WHERE id=offer)<>'accepted' THEN RAISE EXCEPTION 'The observed offer must be accepted'; END IF;
    UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=offer;
    PERFORM complete_accepted_trade_atomic(offer);
    IF NOT EXISTS(SELECT 1 FROM draft_picks WHERE id=offered AND current_owner_id=members[2] AND original_owner_id=original_offered AND NOT is_used)
      OR NOT EXISTS(SELECT 1 FROM draft_picks WHERE id=requested AND current_owner_id=members[1] AND original_owner_id=original_requested AND NOT is_used)
      OR (SELECT status FROM trades WHERE id=offer)<>'completed' THEN
      RAISE EXCEPTION 'The observed settlement must transfer both old-class assets and leave them unused';
    END IF;
    RAISE NOTICE 'FINDING SYNTHETIC phase=%: class=8850 round=3 offered=pending accepted=accepted settled=completed is_used=false current_year=%',phase,COALESCE(next_year,8850);
  END LOOP;
  SELECT jsonb_agg(to_jsonb(pick) ORDER BY id) INTO previous_snapshot FROM draft_picks pick WHERE league_id=league AND season_year=8850 AND round=3;
  UPDATE leagues SET status='playoffs' WHERE id=league;
  PERFORM advance_season_atomic(league);
  IF (SELECT jsonb_agg(to_jsonb(pick) ORDER BY id) FROM draft_picks pick WHERE league_id=league AND season_year=8850 AND round=3) IS DISTINCT FROM previous_snapshot THEN
    RAISE EXCEPTION 'A second rollover must preserve the observed unused class unchanged';
  END IF;
  RAISE NOTICE 'FINDING SYNTHETIC after-second-rollover: all four old round-three assets are unchanged and is_used=false';
END;
$$;
ROLLBACK;
