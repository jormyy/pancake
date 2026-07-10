DELETE FROM public.leagues
 WHERE id IN (
  '00000000-0000-0000-0000-000000050101',
  '00000000-0000-0000-0000-000000050102'
 );
DELETE FROM public.players
 WHERE id IN (
  '00000000-0000-0000-0000-000000050401',
  '00000000-0000-0000-0000-000000050402'
 );
DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000050001';

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000050001', 'authenticated', 'authenticated',
  'waiver-backlog@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-000000050001', 'waiver_backlog', 'Waiver Backlog')
ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name;

INSERT INTO public.leagues (id, name, slug, commissioner_id, status, waiver_mode, weekly_add_limit)
VALUES
  ('00000000-0000-0000-0000-000000050101', 'Contended Waiver League', 'contended-waiver-league', '00000000-0000-0000-0000-000000050001', 'active', 'faab', NULL),
  ('00000000-0000-0000-0000-000000050102', 'Available Waiver League', 'available-waiver-league', '00000000-0000-0000-0000-000000050001', 'active', 'faab', NULL);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000050201', '00000000-0000-0000-0000-000000050101', '00000000-0000-0000-0000-000000050001', 'commissioner', 'Contended'),
  ('00000000-0000-0000-0000-000000050202', '00000000-0000-0000-0000-000000050102', '00000000-0000-0000-0000-000000050001', 'commissioner', 'Available');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-000000050301', '00000000-0000-0000-0000-000000050101', 2099, true),
  ('00000000-0000-0000-0000-000000050302', '00000000-0000-0000-0000-000000050102', 2099, true);

INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions)
VALUES
  ('00000000-0000-0000-0000-000000050401', 'Locked', 'Target', 'FA', 'PG', 1, ARRAY['PG']),
  ('00000000-0000-0000-0000-000000050402', 'Open', 'Target', 'FA', 'SG', 1, ARRAY['SG']);

INSERT INTO public.waiver_priorities (league_id, league_season_id, member_id, priority)
VALUES
  ('00000000-0000-0000-0000-000000050101', '00000000-0000-0000-0000-000000050301', '00000000-0000-0000-0000-000000050201', 1),
  ('00000000-0000-0000-0000-000000050102', '00000000-0000-0000-0000-000000050302', '00000000-0000-0000-0000-000000050202', 1)
ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET priority = EXCLUDED.priority;

INSERT INTO public.waiver_wire_log (
  id, league_id, league_season_id, player_id, dropped_by_member_id, placed_on_waivers_at, clears_at
)
VALUES
  ('00000000-0000-0000-0000-000000050501', '00000000-0000-0000-0000-000000050101', '00000000-0000-0000-0000-000000050301', '00000000-0000-0000-0000-000000050401', '00000000-0000-0000-0000-000000050201', now() - interval '3 days', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-000000050502', '00000000-0000-0000-0000-000000050102', '00000000-0000-0000-0000-000000050302', '00000000-0000-0000-0000-000000050402', '00000000-0000-0000-0000-000000050202', now() - interval '3 days', now() - interval '1 minute');

INSERT INTO public.waiver_claims (
  league_id, league_season_id, member_id, player_id,
  priority_at_submission, process_date, bid_amount, claim_order
)
SELECT
  '00000000-0000-0000-0000-000000050101',
  '00000000-0000-0000-0000-000000050301',
  '00000000-0000-0000-0000-000000050201',
  '00000000-0000-0000-0000-000000050401',
  1, current_date - 2, 0, series
FROM generate_series(1, 200) AS series;

INSERT INTO public.waiver_claims (
  id, league_id, league_season_id, member_id, player_id,
  priority_at_submission, process_date, bid_amount, claim_order
)
VALUES (
  '00000000-0000-0000-0000-000000050601',
  '00000000-0000-0000-0000-000000050102',
  '00000000-0000-0000-0000-000000050302',
  '00000000-0000-0000-0000-000000050202',
  '00000000-0000-0000-0000-000000050402',
  1, current_date - 1, 0, 1
);

CREATE TEMP TABLE waiver_backlog_result AS
SELECT * FROM public.process_next_waiver_claim_atomic(current_date);

DO $$
DECLARE
  v_result waiver_backlog_result%ROWTYPE;
  v_locked_pending int;
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.process_next_waiver_claim_atomic(date)'::regprocedure)
    INTO v_definition;
  IF v_definition !~ '(?is)GROUP BY\s+candidate\.league_id.*candidate\.league_season_id.*candidate\.player_id\s+ORDER BY.*LIMIT 128' THEN
    RAISE EXCEPTION 'Waiver candidate scan is not grouped and bounded';
  END IF;

  SELECT * INTO v_result FROM waiver_backlog_result WHERE processed LIMIT 1;
  IF v_result.claim_id <> '00000000-0000-0000-0000-000000050601' THEN
    RAISE EXCEPTION 'Processor did not skip duplicate contended candidates: %', row_to_json(v_result);
  END IF;

  SELECT count(*) INTO v_locked_pending
    FROM public.waiver_claims
   WHERE league_id = '00000000-0000-0000-0000-000000050101'
     AND status = 'pending';
  IF v_locked_pending <> 200 THEN
    RAISE EXCEPTION 'Contended duplicate group was mutated: % pending', v_locked_pending;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.roster_players
     WHERE league_id = '00000000-0000-0000-0000-000000050102'
       AND player_id = '00000000-0000-0000-0000-000000050402'
  ) THEN
    RAISE EXCEPTION 'Unlocked waiver candidate was not processed';
  END IF;
END $$;
