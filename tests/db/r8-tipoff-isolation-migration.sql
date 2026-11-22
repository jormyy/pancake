\set ON_ERROR_STOP on
\ir rules-support.sql

CREATE TEMP TABLE r8_probe(
  league_id uuid, season_id uuid, member_id uuid, user_ids uuid[], player_id uuid, game_id uuid,
  tipoff_at timestamptz, probe_now timestamptz, legacy_fingerprint text, revision int
);

DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_now timestamptz := now(); v_tipoff timestamptz := v_now + interval '110 seconds';
  v_player uuid := gen_random_uuid(); v_game uuid := gen_random_uuid(); v_fp text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9991);
  UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now()
   WHERE league_id=f.league_id AND member_id=f.member_ids[1];
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, 'R8', 'Legacy', 'PG', ARRAY['PG'], NULL, 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_player, 'draft');
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9991, 1, v_today - 6, v_today)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    VALUES(v_game, '0029991001', 9991, 1, v_today, v_tipoff, 'ZZ', 'ZY', 'Scheduled');
  v_fp := private.pre_tipoff_input_fingerprint(v_today);
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, game_date, status, token, lease_until, input_fingerprint, input_revision, finished_at)
    VALUES(v_tipoff, v_today, 'succeeded', gen_random_uuid(), v_now + interval '2 minutes', v_fp, 0, v_now);
  DELETE FROM private.work_items;
  INSERT INTO r8_probe VALUES(f.league_id, f.season_id, f.member_ids[1], f.user_ids, v_player, v_game, v_tipoff, v_now, v_fp, 0);
  PERFORM pg_temp.check_rules(v_fp IS NOT NULL, 'A: the production-head fingerprint is computed');
END;
$$;

\ir ../../supabase/migrations/20261214011400_league_roster_policies.sql
\ir ../../supabase/migrations/20261214011500_weekly_roster_floor.sql
\ir ../../supabase/migrations/20261214011600_league_auto_ir_schedule.sql
\ir ../../supabase/migrations/20261214011700_enable_official_league_roster_policy.sql
\ir ../../supabase/migrations/20261214011800_tipoff_mode_aware_completion.sql

DO $$
DECLARE p r8_probe%ROWTYPE; v_today date; v_fp text; v_dispatch public.lineup_tipoff_dispatches%ROWTYPE; v_count int;
BEGIN
  SELECT * INTO p FROM r8_probe;
  v_today := (p.probe_now AT TIME ZONE 'America/New_York')::date;
  v_fp := private.pre_tipoff_input_fingerprint(v_today);
  PERFORM pg_temp.check_rules(v_fp = p.legacy_fingerprint, 'A: the migrated shared fingerprint equals the legacy digest');
  PERFORM private.enqueue_pre_tipoff_optimizer(p.probe_now);
  SELECT count(*) INTO v_count FROM private.work_items WHERE kind IN ('pre-tipoff','pre-tipoff-policy');
  PERFORM pg_temp.check_rules(v_count = 0, 'A: applying the five migrations enqueues no pre-tipoff work');
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches WHERE tipoff_at=p.tipoff_at AND scope='';
  PERFORM pg_temp.check_rules(v_dispatch.status='succeeded' AND v_dispatch.input_fingerprint=p.legacy_fingerprint
    AND v_dispatch.input_revision=p.revision, 'A: the succeeded shared dispatch keeps its fingerprint and revision');
  RAISE NOTICE 'PASS r8-tipoff-isolation-migration';
END;
$$;

DO $$
DECLARE p r8_probe%ROWTYPE;
BEGIN
  SELECT * INTO p FROM r8_probe;
  DELETE FROM private.work_items WHERE kind IN ('pre-tipoff','pre-tipoff-policy');
  DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at=p.tipoff_at;
  DELETE FROM public.leagues WHERE id=p.league_id;
  DELETE FROM public.nba_games WHERE id=p.game_id;
  DELETE FROM public.season_weeks WHERE season_year=9991;
  DELETE FROM auth.users WHERE id=ANY(p.user_ids);
END;
$$;
DROP TABLE r8_probe;
