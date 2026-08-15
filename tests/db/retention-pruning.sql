-- prune_unbounded_history: deletes only out-of-window rows and keeps
-- everything the product reads (current+previous season lineups, every
-- season's final standings snapshot, three seasons of transactions, recent
-- ops telemetry).
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000098001', 'authenticated', 'authenticated',
  'retention-pruning@example.test', 'x', now(), '{}'::jsonb,
  '{"username":"retention_pruning"}'::jsonb, now(), now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.leagues (id, name, slug, invite_code, commissioner_id, status)
VALUES (
  '00000000-0000-0000-0000-000000098101', 'Retention Pruning League',
  'retention-pruning-league', 'RETENTIONPRUNE00',
  '00000000-0000-0000-0000-000000098001', 'active'
);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES (
  '00000000-0000-0000-0000-000000098201',
  '00000000-0000-0000-0000-000000098101',
  '00000000-0000-0000-0000-000000098001', 'commissioner', 'Retention Team'
);

-- Four seasons: 3904 current, 3903 previous, 3902 and 3901 old.
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
SELECT
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098101',
  year_value,
  year_value = 3904
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.players (id, first_name, last_name, position, eligible_positions)
VALUES ('00000000-0000-0000-0000-000000098301', 'Retention', 'Fixture', 'PG', ARRAY['PG']);

INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
SELECT year_value, 1, date '2101-01-01', date '2101-01-07'
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.weekly_lineups (league_id, league_season_id, member_id, player_id, week_number, slot_type, game_date)
SELECT
  '00000000-0000-0000-0000-000000098101',
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098201',
  '00000000-0000-0000-0000-000000098301',
  1, 'PG', date '2101-01-01'
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.standings (league_id, league_season_id, member_id, week_number, waiver_priority)
SELECT
  '00000000-0000-0000-0000-000000098101',
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098201',
  week_value, 1
FROM generate_series(3901, 3904) AS year_value
CROSS JOIN generate_series(1, 3) AS week_value;

INSERT INTO public.roster_transactions (league_id, league_season_id, member_id, player_id, transaction_type)
SELECT
  '00000000-0000-0000-0000-000000098101',
  md5('retention-season-' || year_value)::uuid,
  '00000000-0000-0000-0000-000000098201',
  '00000000-0000-0000-0000-000000098301',
  'carry_over'
FROM generate_series(3901, 3904) AS year_value;

INSERT INTO public.sync_runs (id, function_name, started_at, status)
VALUES
  ('00000000-0000-0000-0000-000000098401', 'retention-old', now() - interval '120 days', 'success'),
  ('00000000-0000-0000-0000-000000098402', 'retention-new', now() - interval '1 day', 'success');

INSERT INTO public.projection_sync_runs (id, source, projection_type, source_url, started_at, status)
VALUES
  ('00000000-0000-0000-0000-000000098501', 'fantasypros', 'daily',
   'https://www.fantasypros.com/nba/projections/daily-overall.php', now() - interval '60 days', 'success'),
  ('00000000-0000-0000-0000-000000098502', 'fantasypros', 'daily',
   'https://www.fantasypros.com/nba/projections/daily-overall.php', now() - interval '1 day', 'success');

INSERT INTO public.fantasypros_projection_rows (
  run_id, projection_type, source_url, source_row_number, fetched_at,
  source_player_name, normalized_player_name, match_status
)
SELECT run_id, 'daily', 'https://www.fantasypros.com/nba/projections/daily-overall.php',
       1, now(), 'Retention Fixture', 'retention fixture', 'unmatched'
FROM unnest(ARRAY[
  '00000000-0000-0000-0000-000000098501',
  '00000000-0000-0000-0000-000000098502'
]::uuid[]) AS run_id;

SELECT public.prune_unbounded_history() AS prune_result \gset

DO $$
DECLARE
  v_count int;
BEGIN
  -- Ops telemetry: only out-of-window rows pruned.
  SELECT count(*) INTO v_count FROM public.sync_runs WHERE function_name LIKE 'retention-%';
  IF v_count <> 1 THEN RAISE EXCEPTION 'sync_runs retention wrong: % rows kept', v_count; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sync_runs WHERE function_name = 'retention-new') THEN
    RAISE EXCEPTION 'in-window sync_run was pruned';
  END IF;

  SELECT count(*) INTO v_count FROM public.projection_sync_runs
   WHERE id IN ('00000000-0000-0000-0000-000000098501', '00000000-0000-0000-0000-000000098502');
  IF v_count <> 1 THEN RAISE EXCEPTION 'projection_sync_runs retention wrong: % kept', v_count; END IF;
  SELECT count(*) INTO v_count FROM public.fantasypros_projection_rows
   WHERE run_id = '00000000-0000-0000-0000-000000098501';
  IF v_count <> 0 THEN RAISE EXCEPTION 'old projection rows did not cascade'; END IF;
  SELECT count(*) INTO v_count FROM public.fantasypros_projection_rows
   WHERE run_id = '00000000-0000-0000-0000-000000098502';
  IF v_count <> 1 THEN RAISE EXCEPTION 'in-window projection rows were pruned'; END IF;

  -- Lineups: current + previous season kept, older pruned.
  SELECT count(*) INTO v_count FROM public.weekly_lineups
   WHERE league_id = '00000000-0000-0000-0000-000000098101';
  IF v_count <> 2 THEN RAISE EXCEPTION 'weekly_lineups retention wrong: % kept', v_count; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.weekly_lineups
     WHERE league_season_id = md5('retention-season-3904')::uuid
  ) THEN RAISE EXCEPTION 'current-season lineup pruned'; END IF;

  -- Standings: old seasons keep exactly the final snapshot per member.
  SELECT count(*) INTO v_count FROM public.standings
   WHERE league_season_id = md5('retention-season-3901')::uuid;
  IF v_count <> 1 THEN RAISE EXCEPTION 'old-season standings retention wrong: % kept', v_count; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.standings
     WHERE league_season_id = md5('retention-season-3901')::uuid AND week_number = 3
  ) THEN RAISE EXCEPTION 'final standings snapshot pruned from old season'; END IF;
  SELECT count(*) INTO v_count FROM public.standings
   WHERE league_season_id = md5('retention-season-3904')::uuid;
  IF v_count <> 3 THEN RAISE EXCEPTION 'current-season standings pruned: % kept', v_count; END IF;

  -- Transactions: three seasons kept, the fourth pruned.
  SELECT count(*) INTO v_count FROM public.roster_transactions
   WHERE league_id = '00000000-0000-0000-0000-000000098101';
  IF v_count <> 3 THEN RAISE EXCEPTION 'roster_transactions retention wrong: % kept', v_count; END IF;
  IF EXISTS (
    SELECT 1 FROM public.roster_transactions
     WHERE league_season_id = md5('retention-season-3901')::uuid
  ) THEN RAISE EXCEPTION 'oldest-season transaction not pruned'; END IF;
END $$;

ROLLBACK;
