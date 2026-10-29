BEGIN;
\ir ../../db/rules-support.sql
CREATE TEMP TABLE browser_fixture(data jsonb);
DO $$
DECLARE f record; candidates uuid[]; offer uuid; claim uuid; won uuid; offered_roster uuid; drop_roster uuid; held_roster uuid; pick uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, public.current_season_year_et());
  UPDATE auth.users SET confirmation_token='', recovery_token='', email_change_token_new='', email_change='', instance_id='00000000-0000-0000-0000-000000000000', encrypted_password=extensions.crypt('Local-locks-598-test',extensions.gen_salt('bf')),
    email='pending-locks-'||f.user_ids[1]::text||'@example.test', raw_app_meta_data='{"provider":"email","providers":["email"]}'
    WHERE id=f.user_ids[1];
  INSERT INTO auth.identities(provider_id,user_id,identity_data,provider,created_at,updated_at)
    SELECT id::text,id,jsonb_build_object('sub',id::text,'email',email,'email_verified',true),'email',now(),now()
    FROM auth.users WHERE id=f.user_ids[1];
  UPDATE public.leagues SET name='Pending asset locks',allow_inactive_trades=true,roster_size=20,ir_slots=2,taxi_slots=2 WHERE id=f.league_id;
  UPDATE public.league_members SET team_name=CASE WHEN id=f.member_ids[1] THEN 'Harbor' ELSE 'Summit' END WHERE league_id=f.league_id;
  SELECT array_agg(id ORDER BY display_name) INTO candidates FROM (
    SELECT id,display_name FROM public.players WHERE nba_id IS NOT NULL AND display_name IN ('LeBron James','Stephen Curry','Jayson Tatum','Anthony Edwards','Victor Wembanyama','Nikola Jokic') ORDER BY display_name LIMIT 6
  ) selected;
  IF cardinality(candidates)<5 THEN RAISE EXCEPTION 'Production-shaped player fixture is missing.'; END IF;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],candidates[1],'draft') RETURNING id INTO offered_roster;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],candidates[2],'draft') RETURNING id INTO drop_roster;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],candidates[3],'draft') RETURNING id INTO held_roster;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],candidates[4],'draft');
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(f.league_id,'PG',1),(f.league_id,'SF',1),(f.league_id,'C',1),(f.league_id,'UTIL',2),(f.league_id,'BE',10)
    ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(f.league_id,public.current_season_year_et()+1,1,f.member_ids[1],f.member_ids[1]) RETURNING id INTO pick;
  offer := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[candidates[1]],ARRAY[candidates[4]],ARRAY[pick],'{}');
  claim := public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],candidates[5],candidates[2]);
  UPDATE public.leagues SET roster_size=3,taxi_slots=0 WHERE id=f.league_id;
  UPDATE public.players SET injury_status='Out' WHERE id=candidates[1];
  UPDATE public.players SET injury_status=NULL WHERE id=candidates[6];
  INSERT INTO browser_fixture SELECT jsonb_build_object('leagueId',f.league_id,'seasonId',f.season_id,'memberId',f.member_ids[1],
    'userId',f.user_ids[1],'otherMemberId',f.member_ids[2],'tradeId',offer,'claimId',claim,'playerIds',candidates,
    'rosterIds',ARRAY[offered_roster,drop_roster,held_roster],'pickId',pick,'email','pending-locks-'||f.user_ids[1]::text||'@example.test');
END;
$$;
SELECT data FROM browser_fixture;
COMMIT;
