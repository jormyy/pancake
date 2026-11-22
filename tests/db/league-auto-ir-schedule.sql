BEGIN;
\ir rules-support.sql

CREATE FUNCTION pg_temp.schedule_league(p_today date, p_year int, p_teams int, p_policy boolean)
RETURNS TABLE (league_id uuid, season_id uuid, user_ids uuid[], member_ids uuid[])
LANGUAGE plpgsql AS $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size = 20, ir_slots = 1 WHERE id = f.league_id;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(p_year, 1, p_today - 3, p_today + 3)
    ON CONFLICT DO NOTHING;
  IF p_policy THEN
    INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());
  END IF;
  league_id := f.league_id;
  season_id := f.season_id;
  user_ids := f.user_ids;
  member_ids := f.member_ids;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pg_temp.schedule_player(
  p_league uuid, p_season uuid, p_member uuid, p_name text, p_injury text, p_return text,
  p_on_ir boolean DEFAULT false
)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return)
    VALUES(v_player, p_name, 'Test', 'PG', ARRAY['PG'], p_injury, COALESCE(p_return, 'unknown'));
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir, is_on_taxi)
    VALUES(p_league, p_season, p_member, v_player, 'draft', p_on_ir, false);
  RETURN v_player;
END;
$$;

CREATE FUNCTION pg_temp.schedule_game(p_year int, p_tipoff timestamptz, p_game_date date)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
  VALUES(gen_random_uuid(), '002' || substr(md5(random()::text), 1, 12), p_year, 1,
    p_game_date, p_tipoff, 'AAA', 'BBB', 'Scheduled');
END;
$$;

CREATE FUNCTION pg_temp.schedule_clocks(p_clock timestamptz)
RETURNS TABLE (game_date date, daily_at timestamptz, window_at timestamptz, tipoff timestamptz, tipoff2 timestamptz, tipoff3 timestamptz)
LANGUAGE sql STABLE AS $$
  WITH bounds AS (
    SELECT (p_clock AT TIME ZONE 'America/New_York')::date AS game_date,
      ((p_clock AT TIME ZONE 'America/New_York')::date + 1)::timestamp AT TIME ZONE 'America/New_York' AS day_end
  ), span AS (
    SELECT game_date, LEAST(interval '30 minutes', (day_end - p_clock) * 0.9) AS width
      FROM bounds
  ), times AS (
    SELECT game_date, p_clock + width AS tipoff,
      p_clock + width * (2.0 / 3.0) AS tipoff3,
      p_clock + width * (1.0 / 3.0) AS tipoff2
      FROM span
  )
  SELECT game_date, tipoff - interval '1 minute', tipoff - interval '1 minute', tipoff, tipoff2, tipoff3
    FROM times
$$;

CREATE FUNCTION pg_temp.check_clocks(p_clock timestamptz, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM pg_temp.schedule_clocks(p_clock);
  PERFORM pg_temp.check_rules(c.game_date = (p_clock AT TIME ZONE 'America/New_York')::date,
    p_label || ': the fixture keeps the Eastern date');
  PERFORM pg_temp.check_rules(c.daily_at < c.tipoff AND c.window_at < c.tipoff,
    p_label || ': every clock precedes its tipoff');
  PERFORM pg_temp.check_rules(c.tipoff <= c.window_at + interval '2 minutes',
    p_label || ': the tipoff is inside the pre-tipoff window');
  PERFORM pg_temp.check_rules(c.tipoff2 > p_clock AND c.tipoff3 > c.tipoff2 AND c.tipoff > c.tipoff3,
    p_label || ': the three tipoffs are ordered after the clock');
  PERFORM pg_temp.check_rules(
    (c.daily_at AT TIME ZONE 'America/New_York')::date = c.game_date
    AND (c.window_at AT TIME ZONE 'America/New_York')::date = c.game_date
    AND (c.tipoff AT TIME ZONE 'America/New_York')::date = c.game_date
    AND (c.tipoff2 AT TIME ZONE 'America/New_York')::date = c.game_date
    AND (c.tipoff3 AT TIME ZONE 'America/New_York')::date = c.game_date,
    p_label || ': every clock stays on the fixture date');
END;
$$;

CREATE FUNCTION pg_temp.clear_member(p_league uuid, p_member uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.weekly_lineups WHERE league_id = p_league AND member_id = p_member;
  DELETE FROM public.roster_players WHERE league_id = p_league AND member_id = p_member;
END;
$$;

DO $$
DECLARE
  f record;
  c record;
  k record;
  r jsonb;
  v_today date;
  v_tipoff timestamptz;
  v_daily_at timestamptz;
  v_window timestamptz;
  v_token uuid := gen_random_uuid();
  v_injured uuid;
  v_healthy uuid;
  v_occupant uuid;
  v_injured2 uuid;
  v_tipoff2 timestamptz;
  v_tipoff3 timestamptz;
  v_token2 uuid;
  v_token3 uuid;
BEGIN
  PERFORM pg_temp.check_clocks('2026-11-20 08:00:00-05'::timestamptz, '08:00 ET');
  PERFORM pg_temp.check_clocks('2026-11-20 23:29:00-05'::timestamptz, '23:29 ET');
  PERFORM pg_temp.check_clocks('2026-11-20 23:31:00-05'::timestamptz, '23:31 ET');
  PERFORM pg_temp.check_clocks('2026-11-20 23:45:00-05'::timestamptz, '23:45 ET');
  PERFORM pg_temp.check_clocks('2026-11-20 23:59:30-05'::timestamptz, '23:59:30 ET');
  PERFORM pg_temp.check_clocks('2026-11-21 00:01:00-05'::timestamptz, '00:01 ET');
  SELECT * INTO k FROM pg_temp.schedule_clocks(now());
  v_today := k.game_date;
  v_tipoff := k.tipoff;
  v_daily_at := k.daily_at;
  v_window := k.window_at;
  DELETE FROM private.work_items;
  UPDATE private.league_roster_policies SET auto_ir_all_members = false;
  SELECT * INTO f FROM pg_temp.schedule_league(v_today, 9701, 2, true);
  SELECT * INTO c FROM pg_temp.schedule_league(v_today, 9702, 1, false);
  UPDATE public.lineup_optimizer_settings SET enabled = false, enabled_at = NULL;
  PERFORM pg_temp.schedule_game(9701, v_tipoff, v_today);

  DELETE FROM private.work_items;
  PERFORM private.enqueue_lineup_optimizer(v_daily_at);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind = 'lineup-optimizer'),
    'a policy league enqueues the daily check without an enabled setting');
  DELETE FROM private.work_items;
  DELETE FROM private.league_roster_policies WHERE league_id = f.league_id;
  PERFORM private.enqueue_lineup_optimizer(v_daily_at);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind = 'lineup-optimizer'),
    'a league without the policy does not enqueue the daily check');
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());

  DELETE FROM private.work_items;
  PERFORM private.enqueue_pre_tipoff_optimizer(v_window);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind = 'pre-tipoff-policy' AND payload->>'leagueId' = f.league_id::text),
    'a policy league enqueues the tipoff window without an enabled setting');
  DELETE FROM private.work_items;
  DELETE FROM private.league_roster_policies WHERE league_id = f.league_id;
  PERFORM private.enqueue_pre_tipoff_optimizer(v_window);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind IN ('pre-tipoff','pre-tipoff-policy')),
    'a league without the policy does not enqueue the tipoff window');
  INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members, ir_activated_at) VALUES(f.league_id, true, now());

  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.get_pending_auto_ir_members(v_today)) = 2,
    'the daily auto IR list holds every policy league member with Auto Lineup off');
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.get_pending_auto_ir_members(v_today) WHERE member_id = c.member_ids[1]),
    'the daily auto IR list excludes leagues without the policy');
  UPDATE public.lineup_optimizer_settings SET enabled = true, enabled_at = now()
   WHERE league_id = f.league_id AND league_season_id = f.season_id AND member_id = f.member_ids[1];
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.get_pending_auto_ir_members(v_today)) = 1,
    'the daily auto IR list excludes members with Auto Lineup on');
  UPDATE public.lineup_optimizer_settings SET enabled = false WHERE member_id = f.member_ids[1];

  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
    VALUES(v_tipoff, f.league_id::text, v_today, v_token, 'running', now() + interval '1 minute');
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.get_pending_auto_ir_members(v_today, v_tipoff, v_token, ARRAY[]::uuid[], 100, false, f.league_id::text)) = 2,
    'the tipoff auto IR list holds policy members under the current claim');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.get_pending_auto_ir_members(%L, %L, %L, ARRAY[]::uuid[], 100, false, %L)', v_today, v_tipoff, gen_random_uuid(), f.league_id::text),
    'Tipoff lease expired or changed', 'the tipoff auto IR list rejects a stale claim');

  PERFORM pg_temp.check_rules(
    public.mark_tipoff_ir_member_done(v_tipoff, v_token, f.league_id, f.season_id, f.member_ids[1], f.league_id::text),
    'mark done records the IR-only member');
  PERFORM pg_temp.check_rules(
    public.mark_tipoff_ir_member_done(v_tipoff, v_token, f.league_id, f.season_id, f.member_ids[1], f.league_id::text),
    'mark done is idempotent');
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.lineup_tipoff_members WHERE tipoff_at = v_tipoff AND member_id = f.member_ids[1]) = 1,
    'mark done writes one receipt');
  PERFORM pg_temp.check_rules(
    (SELECT count(*) FROM public.get_pending_auto_ir_members(v_today, v_tipoff, v_token, ARRAY[]::uuid[], 100, false, f.league_id::text)) = 1,
    'a completed IR-only member leaves the window');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.mark_tipoff_ir_member_done(%L, %L, %L, %L, %L, %L)',
      v_tipoff, gen_random_uuid(), f.league_id, f.season_id, f.member_ids[2], f.league_id::text),
    'Tipoff claim is no longer current.', 'mark done rejects a stale claim');
  PERFORM pg_temp.reject_rules(
    format('SELECT public.mark_tipoff_ir_member_done(%L, %L, %L, %L, %L, %L)',
      v_tipoff, v_token, c.league_id, c.season_id, c.member_ids[1], f.league_id::text),
    'Tipoff scope is no longer active.', 'mark done rejects a league without the policy');

  PERFORM public.record_pre_tipoff_lineup_failure(v_tipoff, v_token, f.league_id, f.season_id, f.member_ids[2], 'transient', f.league_id::text);
  PERFORM pg_temp.check_rules(
    EXISTS(SELECT 1 FROM public.lineup_tipoff_members
      WHERE tipoff_at = v_tipoff AND member_id = f.member_ids[2] AND error = 'transient'),
    'a policy member without a setting records its failure');
  DELETE FROM public.lineup_optimizer_settings
   WHERE league_id = c.league_id AND member_id = c.member_ids[1];
  PERFORM pg_temp.reject_rules(
    format('SELECT public.record_pre_tipoff_lineup_failure(%L, %L, %L, %L, %L, %L, %L)',
      v_tipoff, v_token, c.league_id, c.season_id, c.member_ids[1], 'x', f.league_id::text),
    'Tipoff scope is no longer active.', 'a control member without a setting cannot record a failure');

  v_injured := pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Injured', 'Out', (v_today + 14)::text);
  v_healthy := pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Healthy', NULL, NULL);
  INSERT INTO public.weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_injured, 1, v_today, 'PG', false);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    r->'moves' @> jsonb_build_array(jsonb_build_object('kind', 'designate', 'designatePlayerId', v_injured::text)),
    'Auto Lineup off designates the injured player into the open IR slot');
  PERFORM pg_temp.check_rules(
    (SELECT is_on_ir FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_injured),
    'the injured player is on IR');
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.weekly_lineups
      WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_injured),
    'the IR-moved starter leaves the lineup');
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.weekly_lineups
      WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND slot_type = 'PG'),
    'the IR-moved starter slot is left empty');
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.weekly_lineups
      WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_healthy),
    'no starter is chosen for an Auto Lineup off member');

  PERFORM pg_temp.clear_member(f.league_id, f.member_ids[1]);
  v_occupant := pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Occupant', NULL, NULL, true);
  v_injured := pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Injured', 'Out', (v_today + 10)::text);
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    r->'moves' @> jsonb_build_array(jsonb_build_object('kind', 'swap',
      'designatePlayerId', v_injured::text, 'activatePlayerId', v_occupant::text)),
    'Auto Lineup off returns a healthy IR player within capacity');
  PERFORM pg_temp.check_rules(
    NOT (SELECT is_on_ir FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_occupant),
    'the healthy IR player is active again');

  PERFORM pg_temp.clear_member(f.league_id, f.member_ids[1]);
  v_occupant := pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Occupant', NULL, NULL, true);
  PERFORM pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Healthy', NULL, NULL);
  UPDATE public.leagues SET roster_size = 1 WHERE id = f.league_id;
  r := public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(r->'moves') = 0, 'a full IR slot changes nothing');
  PERFORM pg_temp.check_rules(
    r->'notices' @> jsonb_build_array(jsonb_build_object('playerId', v_occupant::text, 'reason', 'healthy_ir_bench_full')),
    'a full IR slot keeps the healthy IR notice');
  UPDATE public.leagues SET roster_size = 20 WHERE id = f.league_id;

  PERFORM pg_temp.clear_member(c.league_id, c.member_ids[1]);
  v_injured := pg_temp.schedule_player(c.league_id, c.season_id, c.member_ids[1], 'Injured', 'Out', (v_today + 14)::text);
  r := public.auto_manage_ir_service(c.league_id, c.season_id, c.member_ids[1]);
  PERFORM pg_temp.check_rules(r = '{"moves": [], "skipped": [], "notices": []}'::jsonb,
    'a control league with Auto Lineup off makes no IR move and keeps no notice');
  PERFORM pg_temp.check_rules(
    NOT (SELECT is_on_ir FROM public.roster_players WHERE league_id = c.league_id AND member_id = c.member_ids[1] AND player_id = v_injured),
    'a control league roster is unchanged');

  UPDATE public.leagues SET ir_slots = 2 WHERE id = f.league_id;
  PERFORM pg_temp.clear_member(f.league_id, f.member_ids[1]);
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(f.league_id, f.season_id, f.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled = true, enabled_at = now();
  v_injured := pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Starter', 'Out', (v_today + 14)::text);
  PERFORM pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'Healthy', NULL, NULL);
  INSERT INTO public.weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_injured, 1, v_today, 'PG', false);
  v_tipoff2 := k.tipoff2;
  PERFORM pg_temp.schedule_game(9701, v_tipoff2, v_today);
  v_token2 := gen_random_uuid();
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
    VALUES(v_tipoff2, f.league_id::text, v_today, v_token2, 'running', now() + interval '1 minute');
  PERFORM private.activate_league_roster_policy(f.league_id);
  PERFORM pg_temp.check_rules(
    (SELECT auto_ir FROM public.get_pending_tipoff_members(v_tipoff2, v_token2, ARRAY[]::uuid[], 100, f.league_id::text) WHERE member_id = f.member_ids[1]),
    'an Auto Lineup on policy member is flagged for IR in the window');
  PERFORM public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_pre_tipoff_lineup_context(f.league_id, f.season_id, f.member_ids[1])->'players') player
      WHERE player->>'playerId' = v_injured::text),
    'the fresh context excludes the IR-moved starter');
  PERFORM public.apply_pre_tipoff_lineup(v_tipoff2, v_token2, f.league_id, f.season_id, f.member_ids[1], '[]'::jsonb, f.league_id::text);
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_injured),
    'the IR-moved starter is not chosen');

  v_injured2 := pg_temp.schedule_player(f.league_id, f.season_id, f.member_ids[1], 'LateScratch', NULL, NULL);
  INSERT INTO public.weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES(f.league_id, f.season_id, f.member_ids[1], v_injured2, 1, v_today, 'SG', false);
  UPDATE public.players SET injury_status = 'Out', injury_expected_return = (v_today + 7)::text WHERE id = v_injured2;
  v_tipoff3 := k.tipoff3;
  PERFORM pg_temp.schedule_game(9701, v_tipoff3, v_today);
  PERFORM pg_temp.schedule_game(9702, v_tipoff3, v_today);
  v_token3 := gen_random_uuid();
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, game_date, token, status, lease_until)
    VALUES(v_tipoff3, v_today, v_token3, 'running', now() + interval '1 minute');
  PERFORM public.auto_manage_ir_service(f.league_id, f.season_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_pre_tipoff_lineup_context(f.league_id, f.season_id, f.member_ids[1])->'players') player
      WHERE player->>'playerId' = v_injured2::text),
    'a late scratch is designated at the second window and not chosen');
  PERFORM pg_temp.check_rules(
    (SELECT is_on_ir FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = v_injured2),
    'the late scratch is on IR');

  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at)
    VALUES(c.league_id, c.season_id, c.member_ids[1], true, now())
    ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled = true, enabled_at = now();
  PERFORM pg_temp.check_rules(
    NOT (SELECT auto_ir FROM public.get_pending_tipoff_members(v_tipoff3, v_token3, ARRAY[]::uuid[], 100) WHERE member_id = c.member_ids[1]),
    'a control league Auto Lineup on member is not flagged for IR');
END;
$$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
