BEGIN;
DO $$
DECLARE owner uuid:=gen_random_uuid(); league uuid:=gen_random_uuid(); member uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); player uuid; birthday date:=(now() AT TIME ZONE 'America/Los_Angeles')::date-interval '25 years'+interval '1 day'; value jsonb;
BEGIN
 INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 VALUES(owner,'authenticated','authenticated',owner||'@example.test','x',now(),'{}','{}',now(),now());
 INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'Player ages',league::text,owner,'setup');
 INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(member,league,owner,'commissioner','Age team');
 INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,2129,true);
 PERFORM public.resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object('provider_id','999701801','first_name','Birthday','last_name','Review','metadata',jsonb_build_object('nba_team','BOS','status','Active','birthdate',birthday))));
 SELECT id INTO STRICT player FROM players WHERE espn_id='999701801';
 PERFORM set_config('request.jwt.claim.sub',owner::text,true);
 SELECT to_jsonb(p) INTO value FROM public.view_player_search(p_include_player_ids:=ARRAY[player],p_season_year:=2129) p;
 IF value->>'birthdate' IS DISTINCT FROM birthday::text OR (value->>'age')::int IS DISTINCT FROM 24 THEN RAISE EXCEPTION 'Player search omits birthdate or miscounts age before birthday'; END IF;
 IF public.view_player(league,member,jsonb_build_object('playerId',player))->'player'->>'birthdate' IS DISTINCT FROM birthday::text THEN RAISE EXCEPTION 'Player profile omits birthdate'; END IF;
 UPDATE players SET birthdate=birthday-1 WHERE id=player;
 SELECT to_jsonb(p) INTO value FROM public.view_player_search(p_include_player_ids:=ARRAY[player],p_season_year:=2129) p;
 IF (value->>'age')::int IS DISTINCT FROM 25 THEN RAISE EXCEPTION 'Player age does not change on birthday'; END IF;
 UPDATE players SET birthdate=NULL WHERE id=player;
 SELECT to_jsonb(p) INTO value FROM public.view_player_search(p_include_player_ids:=ARRAY[player],p_season_year:=2129) p;
 IF value->>'age' IS NOT NULL THEN RAISE EXCEPTION 'Missing birthdate invents an age'; END IF;
END;
$$;
ROLLBACK;
