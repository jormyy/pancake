BEGIN;
DO $$
DECLARE owner uuid:=gen_random_uuid(); league uuid:=gen_random_uuid(); member uuid:=gen_random_uuid(); settings jsonb; rejected boolean:=false;
BEGIN
 INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 VALUES(owner,'authenticated','authenticated',owner||'@example.test','x',now(),'{}','{}',now(),now());
 INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(league,'League timezone',league::text,owner,'setup');
 INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(member,league,owner,'commissioner','Timezone team');
 IF (SELECT to_jsonb(l)->>'timezone' FROM leagues l WHERE id=league) IS DISTINCT FROM 'America/Los_Angeles' THEN
  RAISE EXCEPTION 'League timezone does not default to Los Angeles';
 END IF;
 PERFORM set_config('request.jwt.claim.sub',owner::text,true);
 PERFORM public.update_league_configuration_atomic(league,'{"timezone":"Europe/London"}');
 settings:=public.get_league_settings(league);
 IF settings->>'timezone' IS DISTINCT FROM 'Europe/London' OR public.view_league_settings(league,member)->'league'->>'timezone' IS DISTINCT FROM 'Europe/London' THEN
  RAISE EXCEPTION 'League settings views omit the saved timezone';
 END IF;
 BEGIN PERFORM public.update_league_settings_atomic(league,'{"timezone":"Invalid/City"}'); EXCEPTION WHEN invalid_parameter_value THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Unknown timezone is accepted'; END IF;
END;
$$;
ROLLBACK;
