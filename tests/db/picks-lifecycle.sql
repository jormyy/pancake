BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
CREATE FUNCTION pg_temp.check_post(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END;
$$;
DO $$
#variable_conflict use_variable
<<picks_lifecycle>>
DECLARE
  users uuid[]:='{}'; members uuid[]:='{}'; league uuid; season uuid; old_season uuid; oldest_season uuid;
  created jsonb; draft jsonb; draft_id uuid; chosen uuid; asset uuid; requested_asset uuid; trade_id uuid; source_owner uuid;
  new_season uuid; new_year int; year int:=8610; i int; r int; position int; message text; snapshot jsonb;
  expected uuid[]; actual uuid[]; player uuid; completed jsonb;
BEGIN
  FOR i IN 1..4 LOOP
    users:=array_append(users,gen_random_uuid());
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','x',now(),'{}','{}',now(),now());
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
  created:=create_league('Synthetic pick lifecycle','Owner'); league:=(created->>'id')::uuid;
  SELECT id,season_year INTO season,new_year FROM league_seasons WHERE league_id=league AND is_current;
  SELECT id INTO source_owner FROM league_members WHERE league_id=league;
  PERFORM pg_temp.check_post((SELECT count(*)=9 AND min(season_year)=new_year+1 AND max(season_year)=new_year+3
    AND count(DISTINCT season_year)=3 AND count(DISTINCT round)=3 AND bool_and(current_owner_id=source_owner AND original_owner_id=source_owner)
    FROM draft_picks WHERE league_id=league),'creation allocates three future years and three rounds to the owner');
  FOR i IN 2..4 LOOP
    PERFORM set_config('request.jwt.claim.sub',users[i]::text,true);
    PERFORM join_league_by_invite_code(created->>'invite_code','Team '||i);
  END LOOP;
  PERFORM pg_temp.check_post((SELECT count(*)=36 FROM draft_picks WHERE league_id=league),'join allocates every new manager three years');
  SELECT array_agg(id ORDER BY user_id) INTO members FROM league_members WHERE league_id=league;
  UPDATE league_seasons SET season_year=year WHERE id=season;
  old_season:=gen_random_uuid(); oldest_season:=gen_random_uuid();
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(oldest_season,league,year-2,false),(old_season,league,year-1,false);
  INSERT INTO standings(league_id,league_season_id,member_id,week_number,wins,losses,ties,points_for,points_against,waiver_priority)
  SELECT league,oldest_season,members[n],1,n,0,0,100*n,0,n FROM generate_series(1,3) n;
  INSERT INTO standings(league_id,league_season_id,member_id,week_number,wins,losses,ties,points_for,points_against,waiver_priority)
  VALUES(league,old_season,members[1],1,9,0,0,1,0,1),(league,old_season,members[2],1,8,0,0,1,0,2),
    (league,old_season,members[3],1,7,0,0,1,0,3),(league,old_season,members[1],2,2,0,0,40,0,1),
    (league,old_season,members[2],2,2,0,0,20,0,2),(league,old_season,members[3],2,1,0,0,100,0,3);
  INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
  SELECT league,year,round_value,member,member FROM unnest(members) member CROSS JOIN generate_series(1,3) round_value;
  SELECT id INTO asset FROM draft_picks WHERE league_id=league AND season_year=year AND round=1 AND original_owner_id=members[3];
  UPDATE draft_picks SET current_owner_id=members[1] WHERE id=asset;
  UPDATE leagues SET status='offseason',rookie_draft_order='snake' WHERE id=league;
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.sub',(SELECT commissioner_id::text FROM public.leagues WHERE id=league),true);
  draft:=start_rookie_draft_atomic(league,3,false); draft_id:=(draft->>'id')::uuid;
  PERFORM set_config('request.jwt.claim.sub','',true);
  expected:=ARRAY[members[3],members[1],members[2],members[4]];
  SELECT array_agg(member_id ORDER BY draft_orders.position) INTO actual FROM draft_orders WHERE draft_orders.draft_id=picks_lifecycle.draft_id;
  PERFORM pg_temp.check_post(actual=expected,'rookie order uses latest season and week, win rate, points per game, and new manager last');
  PERFORM pg_temp.check_post((SELECT status='drafting' FROM leagues WHERE id=league),'rookie start marks league drafting');
  PERFORM pg_temp.check_post((SELECT member_id=members[1] AND overall_pick=1 FROM snake_draft_picks WHERE draft_pick_id=asset),'traded pick keeps its owner in the rate-based order');
  FOR r IN 1..3 LOOP
    FOR position IN 1..4 LOOP
      SELECT original_owner_id INTO chosen FROM draft_picks pick JOIN snake_draft_picks slot ON slot.draft_pick_id=pick.id
        WHERE slot.draft_id=picks_lifecycle.draft_id AND slot.overall_pick=(r-1)*4+position;
      PERFORM pg_temp.check_post(chosen=expected[CASE WHEN r%2=0 THEN 5-position ELSE position END],'snake order round '||r||' pick '||position);
    END LOOP;
  END LOOP;
  UPDATE draft_picks SET current_owner_id=members[2] WHERE id=asset;
  PERFORM pg_temp.check_post((SELECT member_id=members[2] FROM snake_draft_picks WHERE draft_pick_id=asset),'owner changes reach an unfilled draft slot');
  FOR i IN 1..12 LOOP
    player:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    VALUES(player,'Synthetic','Pick lifecycle '||player,'PG',ARRAY['PG'],0,1);
    SELECT member_id INTO chosen FROM snake_draft_picks WHERE snake_draft_picks.draft_id=picks_lifecycle.draft_id AND player_id IS NULL ORDER BY overall_pick LIMIT 1;
    completed:=make_snake_pick_atomic(draft_id,chosen,player);
    PERFORM pg_temp.check_post((SELECT is_used AND rookie_draft_id=draft_id FROM draft_picks WHERE id=(completed->'pick'->>'draft_pick_id')::uuid),'drafted asset is consumed '||i);
  END LOOP;
  PERFORM pg_temp.check_post((SELECT status='completed' FROM drafts WHERE id=draft_id),'last pick completes draft');
  UPDATE draft_picks SET current_owner_id=members[3] WHERE id=asset;
  PERFORM pg_temp.check_post((SELECT member_id=members[2] FROM snake_draft_picks WHERE draft_pick_id=asset),'filled slot keeps the historical selecting manager');
  UPDATE leagues SET status='playoffs' WHERE id=league;
  SELECT to_jsonb(s) INTO snapshot FROM league_seasons s WHERE id=old_season;
  SELECT a.new_season_id,a.new_year INTO new_season,new_year FROM advance_season_atomic(league) a;
  PERFORM pg_temp.check_post(new_year=year+1 AND (SELECT count(*)=12 AND count(DISTINCT round)=3 FROM draft_picks WHERE league_id=league AND season_year=new_year+3),'rollover adds all far-year picks');
  PERFORM pg_temp.check_post((SELECT to_jsonb(s)=snapshot FROM league_seasons s WHERE id=old_season),'rollover preserves older history');
  SELECT id INTO asset FROM draft_picks WHERE league_id=league AND season_year=new_year+3 AND round=1 AND original_owner_id=members[1];
  SELECT id INTO requested_asset FROM draft_picks WHERE league_id=league AND season_year=new_year+3 AND round=1 AND original_owner_id=members[2];
  trade_id:=propose_trade_atomic(league,new_season,members[1],members[2],'{}','{}',ARRAY[asset],ARRAY[requested_asset]);
  PERFORM accept_trade_atomic(trade_id,members[2]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=trade_id;
  PERFORM complete_accepted_trade_atomic(trade_id);
  PERFORM pg_temp.check_post((SELECT current_owner_id=members[2] AND original_owner_id=members[1] FROM draft_picks WHERE id=asset),'settled trade transfers current ownership and preserves original ownership');
  BEGIN PERFORM advance_season_atomic(league); EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
  PERFORM pg_temp.check_post(message LIKE '%playoffs or archived%' AND (SELECT count(*)=1 FROM league_seasons WHERE league_id=league AND is_current),'rollover retry cannot create another current season');
END;
$$;
ROLLBACK;
