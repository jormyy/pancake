-- The per-minute cron gates invoke their edge function exactly when the
-- function's own claim would find work on this tick: one cron period ahead of
-- now(), because the edge function claims with a later now(). Observable through
-- edge_invocations; the GUCs point at an unreachable loopback port, so pg_net
-- only enqueues. Runs inside one transaction and rolls back.
BEGIN;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'cron-gate-test-token', true);

CREATE TEMP TABLE gate_results (label text, expected boolean, actual boolean);
CREATE OR REPLACE FUNCTION pg_temp.invoked(p_gate text, p_function text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_before bigint; v_after bigint;
BEGIN
  SELECT count(*) INTO v_before FROM public.edge_invocations WHERE function_name = p_function;
  EXECUTE format('SELECT public.%I()', p_gate);
  SELECT count(*) INTO v_after FROM public.edge_invocations WHERE function_name = p_function;
  RETURN v_after > v_before;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.nominations_gate() RETURNS boolean LANGUAGE sql AS $$
  SELECT pg_temp.invoked('invoke_close_expired_nominations_if_due', 'close-expired-nominations')
$$;
CREATE OR REPLACE FUNCTION pg_temp.stats_gate() RETURNS boolean LANGUAGE sql AS $$
  SELECT pg_temp.invoked('invoke_stats_sync_dispatch_if_due', 'sync-stats')
$$;

-- Nothing to do: neither gate invokes.
INSERT INTO gate_results VALUES ('nominations: no work', false, pg_temp.nominations_gate());
INSERT INTO gate_results VALUES ('stats: no work', false, pg_temp.stats_gate());

-- Draft fixtures: one auction and one snake draft.
INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000f0001', 'authenticated', 'authenticated', 'cron-gate@example.test', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-0000000f0001', 'cron_gate', 'Cron Gate') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget, weekly_add_limit)
VALUES ('00000000-0000-0000-0000-0000000f0101', 'Cron Gate', 'cron-gate', '00000000-0000-0000-0000-0000000f0001', 'drafting', 5, 10, NULL);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES ('00000000-0000-0000-0000-0000000f0201', '00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-0000000f0001', 'commissioner', 'Gate A');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-0000000f0301', '00000000-0000-0000-0000-0000000f0101', 2099, true);
INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions)
VALUES ('00000000-0000-0000-0000-0000000f0401', 'Cron', 'Gate', 'DAL', 'SF', 2, ARRAY['SF']);
INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, budget_per_team, started_at, pick_timer_seconds, rounds)
VALUES
  ('00000000-0000-0000-0000-0000000f0601', '00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-0000000f0301', 'auction', 'in_progress', 10, now(), 30, NULL),
  ('00000000-0000-0000-0000-0000000f0602', '00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-0000000f0301', 'snake', 'in_progress', NULL, now(), 30, 1);
INSERT INTO public.draft_budgets (draft_id, member_id, initial_budget, remaining)
VALUES ('00000000-0000-0000-0000-0000000f0601', '00000000-0000-0000-0000-0000000f0201', 10, 10);
INSERT INTO public.nominations (id, draft_id, nominating_member_id, player_id, nomination_order, status, current_bid_amount, current_bidder_id, countdown_expires_at)
VALUES ('00000000-0000-0000-0000-0000000f0701', '00000000-0000-0000-0000-0000000f0601', '00000000-0000-0000-0000-0000000f0201',
        '00000000-0000-0000-0000-0000000f0401', 1, 'open', 0, NULL, now() + interval '10 minutes');

-- Open nomination: due exactly when its countdown passes within one period.
INSERT INTO gate_results VALUES ('nominations: countdown in 10 min', false, pg_temp.nominations_gate());
UPDATE public.nominations SET countdown_expires_at = now() + interval '61 seconds' WHERE id = '00000000-0000-0000-0000-0000000f0701';
INSERT INTO gate_results VALUES ('nominations: countdown in 61 s', false, pg_temp.nominations_gate());
UPDATE public.nominations SET countdown_expires_at = now() + interval '59 seconds' WHERE id = '00000000-0000-0000-0000-0000000f0701';
INSERT INTO gate_results VALUES ('nominations: countdown in 59 s', true, pg_temp.nominations_gate());
UPDATE public.nominations SET countdown_expires_at = now() - interval '1 second' WHERE id = '00000000-0000-0000-0000-0000000f0701';
INSERT INTO gate_results VALUES ('nominations: countdown passed', true, pg_temp.nominations_gate());
-- The claim agrees: the expired nomination is a candidate of the close RPC.
SAVEPOINT before_close;
INSERT INTO gate_results
SELECT 'nominations: close RPC claims the expired nomination', true,
       EXISTS (SELECT 1 FROM public.close_expired_auction_nominations_atomic(100) WHERE nomination_id = '00000000-0000-0000-0000-0000000f0701');
ROLLBACK TO SAVEPOINT before_close;
-- Only in-progress drafts count.
UPDATE public.drafts SET status = 'paused', paused_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0601';
INSERT INTO gate_results VALUES ('nominations: expired but draft paused', false, pg_temp.nominations_gate());
UPDATE public.drafts SET status = 'completed', paused_at = NULL, completed_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0601';
INSERT INTO gate_results VALUES ('nominations: expired but draft completed', false, pg_temp.nominations_gate());
UPDATE public.nominations SET status = 'no_bid' WHERE id = '00000000-0000-0000-0000-0000000f0701';
UPDATE public.drafts SET status = 'in_progress', completed_at = NULL WHERE id = '00000000-0000-0000-0000-0000000f0601';
INSERT INTO gate_results VALUES ('nominations: nomination already resolved', false, pg_temp.nominations_gate());

-- Snake pick timers.
INSERT INTO public.snake_draft_picks (id, draft_id, overall_pick, round, pick_in_round, member_id, timer_expires_at)
VALUES ('00000000-0000-0000-0000-0000000f0801', '00000000-0000-0000-0000-0000000f0602', 1, 1, 1, '00000000-0000-0000-0000-0000000f0201', now() + interval '5 minutes');
INSERT INTO gate_results VALUES ('snake: timer in 5 min', false, pg_temp.nominations_gate());
UPDATE public.snake_draft_picks SET timer_expires_at = now() + interval '30 seconds' WHERE id = '00000000-0000-0000-0000-0000000f0801';
INSERT INTO gate_results VALUES ('snake: timer in 30 s', true, pg_temp.nominations_gate());
UPDATE public.snake_draft_picks SET timer_expires_at = now() - interval '1 second' WHERE id = '00000000-0000-0000-0000-0000000f0801';
INSERT INTO gate_results VALUES ('snake: timer passed', true, pg_temp.nominations_gate());
SAVEPOINT before_snake;
INSERT INTO gate_results
SELECT 'snake: expiry RPC claims the expired pick', true,
       EXISTS (SELECT 1 FROM public.process_expired_snake_picks_atomic(100) WHERE pick_id = '00000000-0000-0000-0000-0000000f0801');
ROLLBACK TO SAVEPOINT before_snake;
UPDATE public.drafts SET status = 'paused', paused_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0602';
INSERT INTO gate_results VALUES ('snake: timer passed but draft paused', false, pg_temp.nominations_gate());
UPDATE public.drafts SET status = 'in_progress', paused_at = NULL WHERE id = '00000000-0000-0000-0000-0000000f0602';
UPDATE public.snake_draft_picks SET skipped_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0801';
INSERT INTO gate_results VALUES ('snake: pick already skipped', false, pg_temp.nominations_gate());
UPDATE public.snake_draft_picks SET skipped_at = NULL, timer_expires_at = now() - interval '1 second' WHERE id = '00000000-0000-0000-0000-0000000f0801';

-- The gate reads deadlines; it never moves them.
DO $$
BEGIN
  IF (SELECT countdown_expires_at FROM public.nominations WHERE id = '00000000-0000-0000-0000-0000000f0701') <> now() - interval '1 second'
     OR (SELECT timer_expires_at FROM public.snake_draft_picks WHERE id = '00000000-0000-0000-0000-0000000f0801') <> now() - interval '1 second' THEN
    RAISE EXCEPTION 'a gate changed a deadline';
  END IF;
END $$;

-- Failure: with due work and no edge URL the job still fails loudly.
SAVEPOINT before_raise;
SELECT set_config('app.supabase_url', '', true);
DO $$
BEGIN
  PERFORM public.invoke_close_expired_nominations_if_due();
  RAISE EXCEPTION 'expected the gate to raise with due work and no URL configured';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%Edge base URL is not configured%' THEN RAISE; END IF;
END $$;
ROLLBACK TO SAVEPOINT before_raise;
UPDATE public.snake_draft_picks SET timer_expires_at = NULL WHERE id = '00000000-0000-0000-0000-0000000f0801';

-- Stats dispatcher: for every job state the gate invokes now exactly when the
-- claim would take (or dead-letter) the job one period later. One period later
-- is the same fixture with its timestamps moved back by one minute.
CREATE TEMP TABLE stats_cases (label text, job_type text, status text, failed_items int, age interval, claimed_age interval, token boolean, expected boolean);
INSERT INTO stats_cases VALUES
  ('pending',                                  'sync_stats_range:2099-01-01:2099-01-01', 'pending',   0, '0 s',        NULL,         false, true),
  ('failed once, backoff ends in 30 s',        'sync_stats_range:2099-01-02:2099-01-02', 'failed',    1, '30 s',       NULL,         false, true),
  ('failed once, backoff just started',        'sync_stats_range:2099-01-03:2099-01-03', 'failed',    1, '0 s',        NULL,         false, true),
  ('failed twice, backoff ends in 240 s',      'sync_stats_range:2099-01-04:2099-01-04', 'failed',    2, '60 s',       NULL,         false, false),
  ('failed twice, backoff ends in 50 s',       'sync_stats_range:2099-01-05:2099-01-05', 'failed',    2, '250 s',      NULL,         false, true),
  ('failed three times (dead letter)',         'sync_stats_range:2099-01-06:2099-01-06', 'failed',    3, '1 hour',     NULL,         false, false),
  ('completed',                                'sync_stats_range:2099-01-07:2099-01-07', 'completed', 0, '1 hour',     NULL,         false, false),
  ('running, fenced lease 30 s old',           'sync_stats_range:2099-01-08:2099-01-08', 'running',   0, '1 hour',     '30 s',       true,  false),
  ('running, fenced lease 100 s old',          'sync_stats_range:2099-01-09:2099-01-09', 'running',   0, '1 hour',     '100 s',      true,  true),
  ('running, legacy lease 10 min old',         'sync_stats_range:2099-01-10:2099-01-10', 'running',   0, '1 hour',     '10 minutes', false, false),
  ('running, legacy lease 14.5 min old',       'sync_stats_range:2099-01-11:2099-01-11', 'running',   0, '1 hour',     '870 s',      false, true),
  ('malformed pending (claim dead-letters it)', 'sync_stats_range:not-a-range',          'pending',   0, '0 s',        NULL,         false, true),
  ('other job type pending',                   'sync_players',                            'pending',   0, '0 s',        NULL,         false, false);

CREATE OR REPLACE FUNCTION pg_temp.insert_stats_case(p_case stats_cases, p_shift interval) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.sync_jobs (id, job_type, status, failed_items, created_at, completed_at, claimed_at, claim_token, metadata)
  VALUES (v_id, p_case.job_type, p_case.status, p_case.failed_items,
          now() - interval '2 hours' - p_shift,
          CASE WHEN p_case.status IN ('failed', 'completed') THEN now() - p_case.age - p_shift END,
          CASE WHEN p_case.claimed_age IS NOT NULL THEN now() - p_case.claimed_age - p_shift END,
          CASE WHEN p_case.token THEN gen_random_uuid() END,
          '{}'::jsonb);
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.claim_takes(p_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_before public.sync_jobs; v_after public.sync_jobs; v_claimed boolean;
BEGIN
  SELECT * INTO v_before FROM public.sync_jobs WHERE id = p_id;
  SELECT EXISTS (SELECT 1 FROM public.claim_stats_sync_job_atomic(p_id, 120)) INTO v_claimed;
  SELECT * INTO v_after FROM public.sync_jobs WHERE id = p_id;
  RETURN v_claimed OR v_after.status IS DISTINCT FROM v_before.status OR v_after.failed_items IS DISTINCT FROM v_before.failed_items;
END $$;

DO $$
DECLARE v_case stats_cases; v_id uuid; v_gate boolean; v_claim_later boolean; v_claim_now boolean;
BEGIN
  FOR v_case IN SELECT * FROM stats_cases LOOP
    v_id := pg_temp.insert_stats_case(v_case, '0 s');
    v_gate := pg_temp.stats_gate();
    v_claim_now := pg_temp.claim_takes(v_id);
    DELETE FROM public.sync_jobs WHERE id = v_id;
    v_id := pg_temp.insert_stats_case(v_case, '1 minute');
    v_claim_later := pg_temp.claim_takes(v_id);
    DELETE FROM public.sync_jobs WHERE id = v_id;
    INSERT INTO gate_results VALUES ('stats: ' || v_case.label, v_case.expected, v_gate);
    INSERT INTO gate_results VALUES ('stats: ' || v_case.label || ' (claim one period later agrees)', v_gate, v_claim_later);
    IF v_claim_now AND NOT v_gate THEN
      INSERT INTO gate_results VALUES ('stats: ' || v_case.label || ' (claimable now but gate idle)', true, false);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE v_row record; v_failures int := 0;
BEGIN
  FOR v_row IN SELECT * FROM gate_results LOOP
    IF v_row.actual IS DISTINCT FROM v_row.expected THEN
      v_failures := v_failures + 1;
      RAISE WARNING 'FAIL %: expected %, got %', v_row.label, v_row.expected, v_row.actual;
    END IF;
  END LOOP;
  RAISE NOTICE '% gate cases checked', (SELECT count(*) FROM gate_results);
  IF v_failures > 0 THEN RAISE EXCEPTION '% cron gate case(s) failed', v_failures; END IF;
END $$;
ROLLBACK;
