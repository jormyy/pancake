\set ON_ERROR_STOP on
\ir rules-support.sql
BEGIN;
DO $$
DECLARE f record; c record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '110 seconds';
  v_shared private.work_items%ROWTYPE; v_policy private.work_items%ROWTYPE;
  v_due timestamptz; v_state text; v_date date; v_token uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9901);
  UPDATE public.leagues SET roster_size=20, ir_slots=1, timezone='Pacific/Kiritimati' WHERE id=f.league_id;
  UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
    VALUES(f.league_id, 16, true, now(), now());
  SELECT * INTO c FROM pg_temp.rules_fixture(1, 9901);
  UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now() WHERE league_id=c.league_id;
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, game_time)
    VALUES(gen_random_uuid(), '0029901001', 9901, 1, v_today, 'ZZ', 'ZY', 'Scheduled', v_tipoff);
  DELETE FROM private.work_items;
  DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tipoff;

  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff' AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'A: the shared pre-tipoff item is enqueued');

  SELECT * INTO v_shared FROM private.work_claim(1);
  PERFORM pg_temp.check_rules(v_shared.kind='pre-tipoff', 'A: the shared item is claimed first');
  PERFORM pg_temp.check_rules(v_shared.lease_until > now() + interval '4 minutes', 'A: the shared item keeps the five-minute lease');
  PERFORM private.work_finish(v_shared.id, v_shared.lease_token, 'shared worker failed');
  SELECT due_at INTO v_due FROM private.work_items WHERE id=v_shared.id;
  PERFORM pg_temp.check_rules(v_due > now() + interval '30 seconds', 'A: the shared item keeps the base backoff');

  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy' AND payload->>'leagueId'=f.league_id::text AND (payload->>'tipoffAt')::timestamptz=v_tipoff),
    'A: the policy league gets its own scoped work item');
  SELECT * INTO v_policy FROM private.work_claim(1);
  PERFORM pg_temp.check_rules(v_policy.kind='pre-tipoff-policy', 'A: the policy item has its own work identity');
  PERFORM pg_temp.check_rules(v_policy.lease_until <= now() + interval '60 seconds', 'A: the policy item keeps the fast recovery lease');
  PERFORM private.work_finish(v_policy.id, v_policy.lease_token, 'policy worker failed');
  SELECT due_at INTO v_due FROM private.work_items WHERE id=v_policy.id;
  PERFORM pg_temp.check_rules(v_due <= now() + interval '10 seconds', 'A: the policy item retries quickly');
  PERFORM pg_temp.check_rules((SELECT status FROM private.work_items WHERE id=v_policy.id)='failed', 'A: the policy item stays retryable before the tipoff');

  v_token := gen_random_uuid();
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
    VALUES(v_tipoff, '', v_today, v_token, 'queued', now() + interval '2 minutes');
  v_date := public.claim_lineup_tipoff_dispatch(v_tipoff, v_token);
  PERFORM pg_temp.check_rules(v_date = v_today, 'A: an old worker still claims the shared dispatch');
  UPDATE public.lineup_tipoff_dispatches SET status='running', lease_until=now()+interval '1 minute' WHERE tipoff_at=v_tipoff AND scope='';
  PERFORM pg_temp.check_rules(
    EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100, '') WHERE league_id = c.league_id),
    'A: the unrelated opt-in team is admitted in the shared window');
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100, '') WHERE league_id = f.league_id),
    'A: the policy league is not admitted as shared starter work');
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.get_pending_auto_ir_members(v_today, v_tipoff, v_token, ARRAY[]::uuid[], 100, false, '') WHERE league_id = f.league_id),
    'A: the shared item does not run the policy league IR');

  v_token := gen_random_uuid();
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until)
    VALUES(v_tipoff, f.league_id::text, v_today, v_token, 'queued', now() + interval '2 minutes');
  BEGIN
    PERFORM public.claim_lineup_tipoff_dispatch(v_tipoff, v_token);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.check_rules(v_state = 'PT409', 'A: an old worker cannot claim the policy-scoped dispatch');
  v_date := public.claim_lineup_tipoff_dispatch(v_tipoff, v_token, f.league_id::text);
  PERFORM pg_temp.check_rules(v_date = v_today, 'A: a scoped worker claims the policy dispatch');
  UPDATE public.lineup_tipoff_dispatches SET status='running', lease_until=now()+interval '1 minute' WHERE tipoff_at=v_tipoff AND scope=f.league_id::text;
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100, f.league_id::text) WHERE league_id = c.league_id),
    'A: the policy dispatch does not admit the unrelated league');
  PERFORM pg_temp.check_rules(
    EXISTS(SELECT 1 FROM public.get_pending_auto_ir_members(v_today, v_tipoff, v_token, ARRAY[]::uuid[], 100, false, f.league_id::text) WHERE league_id = f.league_id),
    'A: the policy dispatch runs the policy league IR');
  PERFORM pg_temp.check_rules(
    NOT EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100, f.league_id::text)),
    'A: manual policy members never become starter work');
  RAISE NOTICE 'PASS r5b-shared-tipoff';
END;
$$;
ROLLBACK;
