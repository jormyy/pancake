BEGIN;
DO $$
DECLARE
  u uuid := gen_random_uuid(); outsider uuid := gen_random_uuid(); l uuid := gen_random_uuid();
  p uuid := gen_random_uuid(); other uuid := gen_random_uuid(); g uuid := gen_random_uuid();
  result record; rejected boolean;
BEGIN
  IF has_function_privilege('anon', 'public.get_visible_player_totals(uuid,uuid[],integer)', 'EXECUTE')
    OR has_function_privilege('service_role', 'public.get_visible_player_totals(uuid,uuid[],integer)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.get_visible_player_totals(uuid,uuid[],integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Visible totals grants are incorrect';
  END IF;
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status,scoring_settings)
    VALUES(l,'Visible totals',l::text,u,'active','{"points":1,"rebounds":1.2,"double_double":2}');
  INSERT INTO league_members(league_id,user_id,team_name) VALUES(l,u,'Totals team');
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,nba_team)
    VALUES(p,'Visible','Player','PG',ARRAY['PG'],'VST'),(other,'Offscreen','Player','PG',ARRAY['PG'],'OTH');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES(g,'002visible-totals',2097,1,(now() AT TIME ZONE 'America/New_York')::date,'VST','OTH','InProgress',now()-interval '30 minutes');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,rebounds,minutes_played,double_double)
    VALUES(p,g,2097,1,21,10,12.75,true),(other,g,2097,1,99,1,20,false);
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  SELECT * INTO result FROM public.get_visible_player_totals(l,ARRAY[p],2097);
  IF result.player_id IS DISTINCT FROM p OR (result.totals->>'points')::numeric<>21
    OR (result.totals->>'games_played')::integer<>1 OR (result.totals->>'double_double')::integer<>1
    OR (result.totals->>'minutes_played')::numeric<>12.75 OR result.game_status<>'InProgress'
    OR result.rounded_fantasy_average IS NOT NULL THEN RAISE EXCEPTION 'Visible totals or game data are incorrect'; END IF;
  IF (SELECT count(*) FROM public.get_visible_player_totals(l,ARRAY[p,p],2097))<>1 THEN
    RAISE EXCEPTION 'Visible totals duplicate players'; END IF;
  UPDATE player_game_stats SET points=22 WHERE player_id=p;
  IF (SELECT (totals->>'points')::numeric FROM public.get_visible_player_totals(l,ARRAY[p],2097))<>22 THEN
    RAISE EXCEPTION 'Visible totals ignore corrections'; END IF;
  UPDATE leagues SET scoring_settings='{"points":0.333}' WHERE id=l;
  SELECT * INTO result FROM public.get_visible_player_totals(l,ARRAY[p],2097);
  IF result.rounded_fantasy_average IS DISTINCT FROM 7.33::numeric THEN
    RAISE EXCEPTION 'Visible totals lose per-game rounding'; END IF;
  UPDATE player_game_stats SET did_not_play=true WHERE player_id=p;
  IF (SELECT totals FROM public.get_visible_player_totals(l,ARRAY[p],2097))<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Visible totals include DNP stats'; END IF;
  IF EXISTS(SELECT 1 FROM public.get_visible_player_totals(l,ARRAY[]::uuid[],2097)) THEN
    RAISE EXCEPTION 'Empty visible list downloads the pool'; END IF;
  IF (SELECT totals FROM public.get_visible_player_totals(l,ARRAY[p],2096))<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Visible totals mix seasons'; END IF;
  rejected := false;
  BEGIN PERFORM public.get_visible_player_totals(l,array_fill(p,ARRAY[51]),2097);
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'Visible totals accept more than a page'; END IF;
  rejected := false;
  BEGIN PERFORM public.get_visible_player_totals(l,NULL,2097);
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'Visible totals accept an unbounded list'; END IF;
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  rejected := false;
  BEGIN PERFORM public.get_visible_player_totals(l,ARRAY[p],2097);
  EXCEPTION WHEN insufficient_privilege THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'Visible totals leak another league'; END IF;
  PERFORM set_config('request.jwt.claim.sub','',true);
  rejected := false;
  BEGIN PERFORM public.get_visible_player_totals(l,ARRAY[p],2097);
  EXCEPTION WHEN insufficient_privilege THEN rejected := true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'Visible totals allow anonymous reads'; END IF;
END;
$$;
ROLLBACK;
