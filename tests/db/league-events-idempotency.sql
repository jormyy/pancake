BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); v_request_id uuid:=gen_random_uuid(); assignments jsonb;
  day date:=(now() AT TIME ZONE 'America/New_York')::date+1; before_count bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9570);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9570,1,day,day+6);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions) VALUES(player,'Merged','Lineup','PG',ARRAY['PG']);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],player,'draft');
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(f.league_id,'PG',1)
    ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=1;
  assignments:=jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','PG','week_number',1,'is_auto_set',true));
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',f.user_ids[1],'role','authenticated')::text,true);
  PERFORM set_config('request.headers',jsonb_build_object('x-request-id',v_request_id,'x-request-actor',f.user_ids[1])::text,true);
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,day,assignments);
  SELECT count(*) INTO before_count FROM public.league_events WHERE league_id=f.league_id AND kind='lineup.auto_set';
  PERFORM pg_temp.check_rules(before_count=1,'the guarded lineup write records its event');
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,day,assignments);
  PERFORM pg_temp.check_rules((SELECT count(*)=before_count FROM public.league_events WHERE league_id=f.league_id AND kind='lineup.auto_set'),'a replayed request adds no duplicate event');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.request_receipts WHERE request_receipts.request_id=v_request_id AND actor=f.user_ids[1]),'lineup requests retain one receipt');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=day),'a replayed request keeps one lineup');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
