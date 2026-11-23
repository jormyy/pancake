BEGIN;
CREATE TEMP TABLE past_day_fixture AS SELECT
  gen_random_uuid() AS owner, gen_random_uuid() AS league, gen_random_uuid() AS season,
  gen_random_uuid() AS member, gen_random_uuid() AS player,
  (now() AT TIME ZONE 'America/New_York')::date AS et_today,
  CASE WHEN (now() AT TIME ZONE 'Pacific/Kiritimati')::date <> (now() AT TIME ZONE 'America/New_York')::date
    THEN 'Pacific/Kiritimati' ELSE 'Etc/GMT+12' END AS zone;
GRANT SELECT ON past_day_fixture TO authenticated;
CREATE TEMP TABLE past_day_results (rpc text, game_date date, closed boolean);
GRANT INSERT, SELECT ON past_day_results TO authenticated;
CREATE FUNCTION pg_temp.closed_by(p_rpc text, p_game_date date, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_closed boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Past lineups cannot be changed.%' THEN RAISE; END IF;
    v_closed := true;
  END;
  INSERT INTO pg_temp.past_day_results VALUES (p_rpc, p_game_date, v_closed);
END;
$$;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM past_day_fixture;
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES (f.owner,f.owner || '@example.test',jsonb_build_object('username',f.owner));
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,timezone) VALUES (f.league,'Past day',f.league::text,f.owner,'active',f.zone);
  INSERT INTO public.league_members(id,league_id,user_id,role) VALUES (f.member,f.league,f.owner,'commissioner');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES (f.season,f.league,2196,true);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES (2196,1,f.et_today-3,f.et_today+3);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team) VALUES (f.player,'Past','Day','PG',ARRAY['PG'],'PST');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES (f.league,f.season,f.member,f.player,'draft');
  DELETE FROM public.lineup_slot_templates WHERE league_id=f.league;
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES (f.league,'PG',1),(f.league,'BE',3);
  PERFORM set_config('request.jwt.claim.sub',f.owner::text,true);
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; d date;
BEGIN
  SELECT * INTO f FROM past_day_fixture;
  FOREACH d IN ARRAY ARRAY[f.et_today-1, f.et_today] LOOP
    PERFORM pg_temp.closed_by('set_lineup_player_pin', d,
      format('SELECT public.set_lineup_player_pin(%L,%L,%L,%L)', f.league, f.player, d, 'start'));
    PERFORM pg_temp.closed_by('set_player_slot_moves_atomic', d,
      format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,%L,1,%L)', f.member, f.league, f.season, d, '[]'));
    PERFORM pg_temp.closed_by('auto_set_lineup_atomic', d,
      format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,%L)', f.member, f.league, f.season, d, '[]'));
  END LOOP;
END;
$$;
RESET ROLE;
DO $$
DECLARE f record; wrong record;
BEGIN
  SELECT * INTO f FROM past_day_fixture;
  SELECT * INTO wrong FROM pg_temp.past_day_results WHERE closed IS DISTINCT FROM (game_date < f.et_today) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% treats % as % in a % league while the Eastern day is %. Every lineup RPC must call private.assert_lineup_day_open(game_date).',
      wrong.rpc, wrong.game_date, CASE WHEN wrong.closed THEN 'past' ELSE 'open' END, f.zone, f.et_today;
  END IF;
  IF (SELECT count(*) FROM pg_temp.past_day_results) <> 6 THEN RAISE EXCEPTION 'Expected six past-day results'; END IF;
END;
$$;
SELECT 'lineup past-day rule: 3 RPCs agree on the Eastern day' AS result;
ROLLBACK;
