\set ON_ERROR_STOP on
\ir rules-support.sql

CREATE FUNCTION pg_temp.legacy_pre_tipoff_fingerprint(p_game_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH teams AS MATERIALIZED (
    SELECT s.league_id, s.league_season_id, s.member_id, ls.season_year, l.scoring_settings
    FROM public.lineup_optimizer_settings s
    JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
    JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
    WHERE s.enabled AND EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = ls.season_year
    )
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'pins', (SELECT jsonb_agg(to_jsonb(pin) ORDER BY pin.league_id, pin.member_id, pin.player_id)
      FROM public.lineup_player_pins pin JOIN teams t ON t.league_id = pin.league_id
        AND t.league_season_id = pin.league_season_id AND t.member_id = pin.member_id
      WHERE pin.game_date = p_game_date),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id IN (SELECT league_id FROM teams)),
    'games', (SELECT jsonb_agg(jsonb_build_array(g.id, g.game_date, g.game_time, g.home_team,
        g.away_team, private.lineup_game_available(g.status, g.game_status_text)) ORDER BY g.id)
      FROM public.nba_games g WHERE g.game_date = p_game_date),
    'projections', (SELECT jsonb_agg(jsonb_build_array(t.league_id,
        to_jsonb(p)-'projection_fetched_at') ORDER BY t.league_id,p.player_id)
      FROM (SELECT DISTINCT league_id,season_year FROM teams) t CROSS JOIN LATERAL public.get_league_projection_rows(t.league_id,t.season_year,
        p_game_date,'today',ARRAY(SELECT DISTINCT r.player_id FROM roster r
          WHERE r.league_id=t.league_id),1000,0) p)
  )::text);
$$;

BEGIN;

DO $$
DECLARE
  a record; b record;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_now timestamptz := now();
  v_tipoff timestamptz := v_now + interval '110 seconds';
  v_year int := 9992;
  v_a_player uuid := gen_random_uuid();
  v_b_player uuid := gen_random_uuid();
  v_game uuid := gen_random_uuid();
  v_fp_shared text; v_fp_policy text;
BEGIN
  SELECT * INTO a FROM pg_temp.rules_fixture(2, v_year);
  SELECT * INTO b FROM pg_temp.rules_fixture(2, v_year);
  UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now()
   WHERE league_id IN (a.league_id, b.league_id) AND member_id IN (a.member_ids[1], b.member_ids[1]);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES (v_a_player, 'R8', 'Official', 'PG', ARRAY['PG'], NULL, 'unknown', 'ZZ'),
           (v_b_player, 'R8', 'Other', 'PG', ARRAY['PG'], NULL, 'unknown', 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES (a.league_id, a.season_id, a.member_ids[1], v_a_player, 'draft'),
           (b.league_id, b.season_id, b.member_ids[1], v_b_player, 'draft');
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES (v_year, 1, v_today - 6, v_today)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    VALUES (v_game, '0029992001', v_year, 1, v_today, v_tipoff, 'ZZ', 'ZY', 'Scheduled');

  PERFORM pg_temp.check_rules(private.pre_tipoff_input_fingerprint(v_today) = pg_temp.legacy_pre_tipoff_fingerprint(v_today),
    'D: both latches NULL keeps the legacy shared digest');

  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
    VALUES (a.league_id, 16, true, now(), now());

  v_fp_shared := private.pre_tipoff_input_fingerprint(v_today);
  v_fp_policy := private.pre_tipoff_policy_input_fingerprint(v_today, a.league_id);
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until, input_fingerprint, input_revision, finished_at)
    VALUES (v_tipoff, '', v_today, gen_random_uuid(), 'succeeded', v_now + interval '2 minutes', v_fp_shared, 0, v_now),
           (v_tipoff, a.league_id::text, v_today, gen_random_uuid(), 'succeeded', v_now + interval '2 minutes', v_fp_policy, 0, v_now);
  DELETE FROM private.work_items;

  UPDATE public.lineup_optimizer_settings SET enabled = NOT enabled
   WHERE league_id=a.league_id AND member_id=a.member_ids[1];
  PERFORM private.enqueue_pre_tipoff_optimizer(v_now);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=a.league_id::text AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: an official Auto Lineup flip reopens the official scope');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff' AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: an official Auto Lineup flip leaves the shared scope closed');
  UPDATE public.lineup_tipoff_dispatches SET input_fingerprint=private.pre_tipoff_policy_input_fingerprint(v_today, a.league_id)
   WHERE tipoff_at=v_tipoff AND scope=a.league_id::text;
  DELETE FROM private.work_items;

  UPDATE public.players SET injury_status='Out', injury_expected_return=(v_today + 14)::text WHERE id=v_a_player;
  PERFORM private.enqueue_pre_tipoff_optimizer(v_now);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=a.league_id::text AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: an official-only injury change reopens the official scope');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff' AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: an official-only injury change leaves the shared scope closed');
  UPDATE public.lineup_tipoff_dispatches SET input_fingerprint=private.pre_tipoff_policy_input_fingerprint(v_today, a.league_id)
   WHERE tipoff_at=v_tipoff AND scope=a.league_id::text;
  DELETE FROM private.work_items;

  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, status, process_date)
    VALUES (a.league_id, a.season_id, a.member_ids[1], v_a_player, 1, 'pending', v_today);
  PERFORM private.enqueue_pre_tipoff_optimizer(v_now);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=a.league_id::text AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: an official-only reservation reopens the official scope');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff' AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: an official-only reservation leaves the shared scope closed');
  UPDATE public.lineup_tipoff_dispatches SET input_fingerprint=private.pre_tipoff_policy_input_fingerprint(v_today, a.league_id)
   WHERE tipoff_at=v_tipoff AND scope=a.league_id::text;
  DELETE FROM private.work_items;

  DELETE FROM public.waiver_claims WHERE league_id=a.league_id AND member_id=a.member_ids[1] AND player_id=v_a_player;
  PERFORM private.enqueue_pre_tipoff_optimizer(v_now);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=a.league_id::text AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: removing an official-only reservation reopens the official scope');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff' AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'B: removing an official-only reservation leaves the shared scope closed');
  UPDATE public.lineup_tipoff_dispatches SET input_fingerprint=private.pre_tipoff_policy_input_fingerprint(v_today, a.league_id)
   WHERE tipoff_at=v_tipoff AND scope=a.league_id::text;
  DELETE FROM private.work_items;

  UPDATE public.players SET injury_status='Out', injury_expected_return=(v_today + 7)::text WHERE id=v_b_player;
  PERFORM private.enqueue_pre_tipoff_optimizer(v_now);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff' AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'C: an other-league eligibility change reopens the shared scope');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=a.league_id::text AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'C: an other-league eligibility change leaves the official scope closed');

  DELETE FROM private.work_items;
  UPDATE private.league_roster_policies SET floor_activated_at=NULL, ir_activated_at=NULL WHERE league_id=a.league_id;
  PERFORM private.enqueue_pre_tipoff_optimizer(v_now);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=a.league_id::text AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'E: a cleared policy does not enqueue scoped work for its leftover dispatch');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff' AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'E: a cleared policy returns its enabled member to the shared scope');

  RAISE NOTICE 'PASS r8-tipoff-isolation';
END;
$$;

ROLLBACK;
