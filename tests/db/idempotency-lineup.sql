\ir idempotency-support.sql
INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
SELECT f.league_id,f.season_id,f.member_ids[1],p.id,'draft' FROM idempotency_fixture f CROSS JOIN idempotency_players p WHERE p.n<=2;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
VALUES(2901,1,current_date,current_date+6) ON CONFLICT(season_year,week_number) DO NOTHING;
INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count)
SELECT league_id,'PG',2 FROM idempotency_fixture ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=2;
DO $$
DECLARE f record; player uuid; assignments jsonb;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  SELECT id INTO player FROM idempotency_players WHERE n=1;
  PERFORM pg_temp.retry('lineup moves', f.user_ids[1], format('public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,%L::jsonb)',f.member_ids[1],f.league_id,f.season_id,current_date+1,jsonb_build_array(jsonb_build_object('player_id',player,'slot_type','PG'))), 'public.set_player_slot_moves_atomic');
  PERFORM pg_temp.retry('lineup single', f.user_ids[1], format('public.set_player_slot_atomic(%L,%L,%L,%L,%L,%L,1)',f.member_ids[1],f.league_id,f.season_id,player,current_date+1,'BE'), 'public.set_player_slot_atomic');
  SELECT jsonb_agg(jsonb_build_object('player_id',id,'slot_type','PG','week_number',1,'is_auto_set',true)) INTO assignments FROM idempotency_players WHERE n<=2;
  PERFORM pg_temp.retry('auto set', f.user_ids[1], format('public.auto_set_lineup_atomic(%L,%L,%L,%L,%L::jsonb)',f.member_ids[1],f.league_id,f.season_id,current_date+1,assignments), 'public.auto_set_lineup_atomic');
  PERFORM pg_temp.retry('service auto set', f.user_ids[1], format('public.auto_set_lineup_service_atomic(%L,%L,%L,%L,%L::jsonb)',f.member_ids[1],f.league_id,f.season_id,current_date+2,assignments), 'public.auto_set_lineup_service_atomic',false,f.member_ids[1]::text||':'||(current_date+2)::text);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM weekly_lineups WHERE league_id=f.league_id AND game_date=current_date+1 AND slot_type='PG'), 'two intended starters');
END;
$$;
DELETE FROM season_weeks WHERE season_year=2901;
\ir idempotency-cleanup.sql
