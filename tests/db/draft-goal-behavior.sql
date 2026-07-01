BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000010001', 'authenticated', 'authenticated', 'draft-goal-commish@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000010002', 'authenticated', 'authenticated', 'draft-goal-manager@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES
  ('00000000-0000-0000-0000-000000010001', 'draft_goal_commish', 'Draft Goal Commish'),
  ('00000000-0000-0000-0000-000000010002', 'draft_goal_manager', 'Draft Goal Manager')
ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name;

INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, nba_draft_number, eligible_positions)
VALUES
  ('00000000-0000-0000-0000-000000010101', 'Mock', 'Top', 'ATL', 'PG', 0, 1, ARRAY['PG']),
  ('00000000-0000-0000-0000-000000010102', 'Mock', 'Fallback', 'BOS', 'SG', 0, 2, ARRAY['SG']),
  ('00000000-0000-0000-0000-000000010103', 'Delete', 'Candidate', 'CHI', 'SF', 0, 3, ARRAY['SF']);

-- Mock auto-pick must use draft-only availability, not real roster availability.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget)
VALUES ('00000000-0000-0000-0000-000000010201', 'Mock Auto Pick League', 'mock-auto-pick-league', '00000000-0000-0000-0000-000000010001', 'drafting', 12, 200);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000010301', '00000000-0000-0000-0000-000000010201', '00000000-0000-0000-0000-000000010001', 'commissioner', 'Mock Commish'),
  ('00000000-0000-0000-0000-000000010302', '00000000-0000-0000-0000-000000010201', '00000000-0000-0000-0000-000000010002', 'manager', 'Mock Manager');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-000000010401', '00000000-0000-0000-0000-000000010201', 2099, true);

INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via)
VALUES ('00000000-0000-0000-0000-000000010501', '00000000-0000-0000-0000-000000010201', '00000000-0000-0000-0000-000000010401', '00000000-0000-0000-0000-000000010301', '00000000-0000-0000-0000-000000010101', 'draft');

INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, started_at, is_mock, pick_timer_seconds, rounds, timer_expiry_behavior)
VALUES ('00000000-0000-0000-0000-000000010601', '00000000-0000-0000-0000-000000010201', '00000000-0000-0000-0000-000000010401', 'snake', 'in_progress', now(), true, 5, 1, 'auto_pick');

INSERT INTO public.snake_draft_picks (id, draft_id, overall_pick, round, pick_in_round, member_id, timer_expires_at)
VALUES ('00000000-0000-0000-0000-000000010701', '00000000-0000-0000-0000-000000010601', 1, 1, 1, '00000000-0000-0000-0000-000000010302', now() - interval '1 second');

CREATE TEMP TABLE draft_goal_expiry_results AS
SELECT * FROM public.process_expired_snake_picks_atomic(10);

DO $$
DECLARE
  v_result draft_goal_expiry_results%ROWTYPE;
BEGIN
  SELECT * INTO v_result
    FROM draft_goal_expiry_results
   WHERE draft_id = '00000000-0000-0000-0000-000000010601';

  IF v_result.error_code IS NOT NULL OR v_result.player_id <> '00000000-0000-0000-0000-000000010101' THEN
    RAISE EXCEPTION 'Mock auto-pick did not select the top draft-available player: %', row_to_json(v_result);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.roster_transactions
     WHERE league_id = '00000000-0000-0000-0000-000000010201'
       AND player_id = '00000000-0000-0000-0000-000000010101'
  ) THEN
    RAISE EXCEPTION 'Mock auto-pick wrote a real roster transaction';
  END IF;
END $$;

-- Manual picks after timer expiry must not bypass the configured timeout
-- policy, but the server auto-pick path must still resolve auto-pick drafts.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget)
VALUES ('00000000-0000-0000-0000-000000010207', 'Manual Expired Pick League', 'manual-expired-pick-league', '00000000-0000-0000-0000-000000010001', 'drafting', 12, 200);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000010313', '00000000-0000-0000-0000-000000010207', '00000000-0000-0000-0000-000000010001', 'commissioner', 'Expired Commish'),
  ('00000000-0000-0000-0000-000000010314', '00000000-0000-0000-0000-000000010207', '00000000-0000-0000-0000-000000010002', 'manager', 'Expired Manager');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-000000010407', '00000000-0000-0000-0000-000000010207', 2099, true);

INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, started_at, is_mock, pick_timer_seconds, rounds, timer_expiry_behavior)
VALUES ('00000000-0000-0000-0000-000000010611', '00000000-0000-0000-0000-000000010207', '00000000-0000-0000-0000-000000010407', 'snake', 'in_progress', now(), true, 5, 1, 'auto_pick');

INSERT INTO public.snake_draft_picks (id, draft_id, overall_pick, round, pick_in_round, member_id, timer_expires_at)
VALUES ('00000000-0000-0000-0000-000000010711', '00000000-0000-0000-0000-000000010611', 1, 1, 1, '00000000-0000-0000-0000-000000010313', now() - interval '1 second');

DO $$
DECLARE
  v_expiry_result record;
BEGIN
  BEGIN
    PERFORM public.make_snake_pick_atomic(
      '00000000-0000-0000-0000-000000010611',
      '00000000-0000-0000-0000-000000010313',
      '00000000-0000-0000-0000-000000010101'
    );
    RAISE EXCEPTION 'Expired manual snake pick was incorrectly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Pick timer has expired' THEN
      RAISE EXCEPTION 'Expired manual snake pick failed with wrong error: %', SQLERRM;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.snake_draft_picks
     WHERE id = '00000000-0000-0000-0000-000000010711'
       AND player_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Expired manual pick mutated the draft slot';
  END IF;

  BEGIN
    PERFORM public.auto_pick_snake_pick_atomic(
      '00000000-0000-0000-0000-000000010611',
      '00000000-0000-0000-0000-000000010313',
      'manual'
    );
    RAISE EXCEPTION 'Expired user-facing auto-pick was incorrectly accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Pick timer has expired' THEN
      RAISE EXCEPTION 'Expired user-facing auto-pick failed with wrong error: %', SQLERRM;
    END IF;
  END;

  SELECT *
    INTO v_expiry_result
    FROM public.process_expired_snake_pick_atomic('00000000-0000-0000-0000-000000010611');

  IF v_expiry_result.player_id <> '00000000-0000-0000-0000-000000010101' THEN
    RAISE EXCEPTION 'Server expiry processor did not resolve the expired pick: %', row_to_json(v_expiry_result);
  END IF;
END $$;

-- Skip and pause timeout policies must be server-authoritative and audited.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget)
VALUES
  ('00000000-0000-0000-0000-000000010202', 'Timer Policy League', 'timer-policy-league', '00000000-0000-0000-0000-000000010001', 'drafting', 12, 200),
  ('00000000-0000-0000-0000-000000010206', 'Timer Ownership League', 'timer-ownership-league', '00000000-0000-0000-0000-000000010001', 'drafting', 12, 200);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000010303', '00000000-0000-0000-0000-000000010202', '00000000-0000-0000-0000-000000010001', 'commissioner', 'Timer Commish'),
  ('00000000-0000-0000-0000-000000010304', '00000000-0000-0000-0000-000000010202', '00000000-0000-0000-0000-000000010002', 'manager', 'Timer Manager'),
  ('00000000-0000-0000-0000-000000010311', '00000000-0000-0000-0000-000000010206', '00000000-0000-0000-0000-000000010001', 'commissioner', 'Ownership Commish'),
  ('00000000-0000-0000-0000-000000010312', '00000000-0000-0000-0000-000000010206', '00000000-0000-0000-0000-000000010002', 'manager', 'Ownership Manager');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-000000010402', '00000000-0000-0000-0000-000000010202', 2099, true),
  ('00000000-0000-0000-0000-000000010406', '00000000-0000-0000-0000-000000010206', 2099, true);

INSERT INTO public.draft_picks (id, league_id, season_year, round, original_owner_id, current_owner_id)
VALUES
  ('00000000-0000-0000-0000-000000010801', '00000000-0000-0000-0000-000000010202', 2099, 1, '00000000-0000-0000-0000-000000010303', '00000000-0000-0000-0000-000000010303'),
  ('00000000-0000-0000-0000-000000010802', '00000000-0000-0000-0000-000000010202', 2099, 1, '00000000-0000-0000-0000-000000010304', '00000000-0000-0000-0000-000000010304'),
  ('00000000-0000-0000-0000-000000010805', '00000000-0000-0000-0000-000000010206', 2099, 1, '00000000-0000-0000-0000-000000010311', '00000000-0000-0000-0000-000000010312');

INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, started_at, is_mock, pick_timer_seconds, rounds, timer_expiry_behavior)
VALUES
  ('00000000-0000-0000-0000-000000010602', '00000000-0000-0000-0000-000000010202', '00000000-0000-0000-0000-000000010402', 'snake', 'in_progress', now(), false, 5, 1, 'skip_pick'),
  ('00000000-0000-0000-0000-000000010603', '00000000-0000-0000-0000-000000010202', '00000000-0000-0000-0000-000000010402', 'snake', 'in_progress', now(), true, 5, 1, 'pause_draft'),
  ('00000000-0000-0000-0000-000000010606', '00000000-0000-0000-0000-000000010202', '00000000-0000-0000-0000-000000010402', 'snake', 'in_progress', now(), true, 5, 1, 'commissioner_pick'),
  ('00000000-0000-0000-0000-000000010609', '00000000-0000-0000-0000-000000010202', '00000000-0000-0000-0000-000000010402', 'snake', 'in_progress', now(), true, 5, 1, 'commissioner_pick'),
  ('00000000-0000-0000-0000-000000010610', '00000000-0000-0000-0000-000000010206', '00000000-0000-0000-0000-000000010406', 'snake', 'in_progress', now(), false, 5, 1, 'skip_pick');

INSERT INTO public.snake_draft_picks (id, draft_id, overall_pick, round, pick_in_round, member_id, draft_pick_id, timer_expires_at)
VALUES
  ('00000000-0000-0000-0000-000000010702', '00000000-0000-0000-0000-000000010602', 1, 1, 1, '00000000-0000-0000-0000-000000010303', '00000000-0000-0000-0000-000000010801', now() - interval '1 second'),
  ('00000000-0000-0000-0000-000000010703', '00000000-0000-0000-0000-000000010602', 2, 1, 2, '00000000-0000-0000-0000-000000010304', '00000000-0000-0000-0000-000000010802', NULL),
  ('00000000-0000-0000-0000-000000010704', '00000000-0000-0000-0000-000000010603', 1, 1, 1, '00000000-0000-0000-0000-000000010303', NULL, now() - interval '1 second'),
  ('00000000-0000-0000-0000-000000010706', '00000000-0000-0000-0000-000000010606', 1, 1, 1, '00000000-0000-0000-0000-000000010303', NULL, now() - interval '1 second'),
  ('00000000-0000-0000-0000-000000010709', '00000000-0000-0000-0000-000000010609', 1, 1, 1, '00000000-0000-0000-0000-000000010303', NULL, now() + interval '30 seconds'),
  ('00000000-0000-0000-0000-000000010710', '00000000-0000-0000-0000-000000010610', 1, 1, 1, '00000000-0000-0000-0000-000000010311', '00000000-0000-0000-0000-000000010805', now() - interval '1 second');

INSERT INTO draft_goal_expiry_results
SELECT * FROM public.process_expired_snake_picks_atomic(10);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.snake_draft_picks
     WHERE id = '00000000-0000-0000-0000-000000010702'
       AND skipped_at IS NOT NULL
       AND skip_reason = 'timer_expired'
       AND timer_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Skip timeout did not mark the expired pick skipped';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.draft_picks
     WHERE id = '00000000-0000-0000-0000-000000010801'
       AND is_used = true
       AND rookie_draft_id = '00000000-0000-0000-0000-000000010602'
  ) THEN
    RAISE EXCEPTION 'Skip timeout did not consume the real pick asset';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.snake_draft_picks
     WHERE id = '00000000-0000-0000-0000-000000010703'
       AND timer_expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Skip timeout did not advance the timer to the next pick';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.drafts
     WHERE id = '00000000-0000-0000-0000-000000010603'
       AND status = 'paused'
       AND paused_at IS NOT NULL
       AND pause_reason = 'timer_expired_pause'
  ) THEN
    RAISE EXCEPTION 'Pause timeout did not pause the draft';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.draft_audit_logs
     WHERE draft_id = '00000000-0000-0000-0000-000000010602'
       AND action = 'skip_pick'
       AND metadata->>'reason' = 'timer_expired'
  ) THEN
    RAISE EXCEPTION 'Skip timeout audit row missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.draft_audit_logs
     WHERE draft_id = '00000000-0000-0000-0000-000000010603'
       AND action = 'timer_expired_pause'
       AND metadata->>'behavior' = 'pause_draft'
  ) THEN
    RAISE EXCEPTION 'Pause timeout audit row missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.drafts
     WHERE id = '00000000-0000-0000-0000-000000010606'
       AND status = 'paused'
       AND paused_at IS NOT NULL
       AND pause_reason = 'timer_expired_commissioner_pick'
  ) THEN
    RAISE EXCEPTION 'Commissioner-pick timeout did not pause the draft';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.draft_audit_logs
     WHERE draft_id = '00000000-0000-0000-0000-000000010606'
       AND action = 'timer_expired_commissioner_pick'
       AND metadata->>'behavior' = 'commissioner_pick'
  ) THEN
    RAISE EXCEPTION 'Commissioner-pick timeout audit row missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM draft_goal_expiry_results
     WHERE pick_id = '00000000-0000-0000-0000-000000010710'
       AND error_code IS NOT NULL
       AND error_message = 'Draft-pick asset is no longer owned by the manager on the clock'
  ) THEN
    RAISE EXCEPTION 'Skip timeout did not reject a traded-away pick asset';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.snake_draft_picks
     WHERE id = '00000000-0000-0000-0000-000000010710'
       AND skipped_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Skip timeout marked a traded-away pick slot as skipped';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.draft_picks
     WHERE id = '00000000-0000-0000-0000-000000010805'
       AND is_used = true
  ) THEN
    RAISE EXCEPTION 'Skip timeout consumed a traded-away pick asset';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    PERFORM public.resume_draft_atomic(
      '00000000-0000-0000-0000-000000010606',
      '00000000-0000-0000-0000-000000010001'
    );
    RAISE EXCEPTION 'Commissioner-pick timeout was incorrectly resumable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Draft is waiting for a commissioner pick.' THEN
      RAISE EXCEPTION 'Commissioner-pick timeout resume failed with wrong error: %', SQLERRM;
    END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.drafts
     WHERE id = '00000000-0000-0000-0000-000000010606'
       AND status = 'paused'
       AND pause_reason = 'timer_expired_commissioner_pick'
  ) THEN
    RAISE EXCEPTION 'Commissioner-pick timeout resume attempt changed draft state';
  END IF;
END $$;

SELECT public.pause_draft_atomic(
  '00000000-0000-0000-0000-000000010609',
  '00000000-0000-0000-0000-000000010001'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.drafts
     WHERE id = '00000000-0000-0000-0000-000000010609'
       AND status = 'paused'
       AND pause_reason = 'manual'
  ) THEN
    RAISE EXCEPTION 'Manual pause did not record manual pause reason';
  END IF;

  BEGIN
    PERFORM public.commissioner_snake_pick_atomic(
      '00000000-0000-0000-0000-000000010609',
      '00000000-0000-0000-0000-000000010303',
      '00000000-0000-0000-0000-000000010103',
      '00000000-0000-0000-0000-000000010001'
    );
    RAISE EXCEPTION 'Manual commissioner-pick pause was incorrectly pickable';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Draft is not waiting for a commissioner pick' THEN
      RAISE EXCEPTION 'Manual commissioner-pick pause failed with wrong error: %', SQLERRM;
    END IF;
  END;
END $$;

SELECT public.commissioner_snake_pick_atomic(
  '00000000-0000-0000-0000-000000010606',
  '00000000-0000-0000-0000-000000010303',
  '00000000-0000-0000-0000-000000010102',
  '00000000-0000-0000-0000-000000010001'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.snake_draft_picks
     WHERE id = '00000000-0000-0000-0000-000000010706'
       AND player_id = '00000000-0000-0000-0000-000000010102'
       AND picked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Commissioner pick did not record the selected player';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.drafts
     WHERE id = '00000000-0000-0000-0000-000000010606'
       AND status = 'completed'
       AND pause_reason IS NULL
  ) THEN
    RAISE EXCEPTION 'Commissioner pick did not complete the one-pick mock draft';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.draft_audit_logs
     WHERE draft_id = '00000000-0000-0000-0000-000000010606'
       AND action = 'commissioner_pick'
       AND actor_user_id = '00000000-0000-0000-0000-000000010001'
  ) THEN
    RAISE EXCEPTION 'Commissioner pick audit row missing';
  END IF;
END $$;

-- Completed real rookie drafts should share one activation policy: activate
-- automatically only when current-season, fully picked, and no roster overflow.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget)
VALUES
  ('00000000-0000-0000-0000-000000010204', 'Activation Ready League', 'activation-ready-league', '00000000-0000-0000-0000-000000010001', 'drafting', 12, 200),
  ('00000000-0000-0000-0000-000000010205', 'Activation Overflow League', 'activation-overflow-league', '00000000-0000-0000-0000-000000010001', 'drafting', 1, 200);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000010307', '00000000-0000-0000-0000-000000010204', '00000000-0000-0000-0000-000000010001', 'commissioner', 'Activation Commish'),
  ('00000000-0000-0000-0000-000000010308', '00000000-0000-0000-0000-000000010204', '00000000-0000-0000-0000-000000010002', 'manager', 'Activation Manager'),
  ('00000000-0000-0000-0000-000000010309', '00000000-0000-0000-0000-000000010205', '00000000-0000-0000-0000-000000010001', 'commissioner', 'Overflow Commish'),
  ('00000000-0000-0000-0000-000000010310', '00000000-0000-0000-0000-000000010205', '00000000-0000-0000-0000-000000010002', 'manager', 'Overflow Manager');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-000000010404', '00000000-0000-0000-0000-000000010204', 2099, true),
  ('00000000-0000-0000-0000-000000010405', '00000000-0000-0000-0000-000000010205', 2099, true);

INSERT INTO public.roster_players (id, league_id, league_season_id, member_id, player_id, acquired_via)
VALUES ('00000000-0000-0000-0000-000000010502', '00000000-0000-0000-0000-000000010205', '00000000-0000-0000-0000-000000010405', '00000000-0000-0000-0000-000000010309', '00000000-0000-0000-0000-000000010102', 'draft');

INSERT INTO public.draft_picks (id, league_id, season_year, round, original_owner_id, current_owner_id)
VALUES
  ('00000000-0000-0000-0000-000000010803', '00000000-0000-0000-0000-000000010204', 2099, 1, '00000000-0000-0000-0000-000000010307', '00000000-0000-0000-0000-000000010307'),
  ('00000000-0000-0000-0000-000000010804', '00000000-0000-0000-0000-000000010205', 2099, 1, '00000000-0000-0000-0000-000000010309', '00000000-0000-0000-0000-000000010309');

INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, started_at, is_mock, pick_timer_seconds, rounds, timer_expiry_behavior)
VALUES
  ('00000000-0000-0000-0000-000000010607', '00000000-0000-0000-0000-000000010204', '00000000-0000-0000-0000-000000010404', 'snake', 'in_progress', now(), false, 5, 1, 'auto_pick'),
  ('00000000-0000-0000-0000-000000010608', '00000000-0000-0000-0000-000000010205', '00000000-0000-0000-0000-000000010405', 'snake', 'in_progress', now(), false, 5, 1, 'auto_pick');

INSERT INTO public.snake_draft_picks (id, draft_id, overall_pick, round, pick_in_round, member_id, draft_pick_id, timer_expires_at)
VALUES
  ('00000000-0000-0000-0000-000000010707', '00000000-0000-0000-0000-000000010607', 1, 1, 1, '00000000-0000-0000-0000-000000010307', '00000000-0000-0000-0000-000000010803', now() + interval '30 seconds'),
  ('00000000-0000-0000-0000-000000010708', '00000000-0000-0000-0000-000000010608', 1, 1, 1, '00000000-0000-0000-0000-000000010309', '00000000-0000-0000-0000-000000010804', now() + interval '30 seconds');

DO $$
DECLARE
  v_ready_result jsonb;
  v_overflow_result jsonb;
BEGIN
  v_ready_result := public.make_snake_pick_atomic(
    '00000000-0000-0000-0000-000000010607',
    '00000000-0000-0000-0000-000000010307',
    '00000000-0000-0000-0000-000000010103'
  );
  IF v_ready_result->>'activated' <> 'true' THEN
    RAISE EXCEPTION 'No-overflow completion did not activate league: %', v_ready_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.leagues
     WHERE id = '00000000-0000-0000-0000-000000010204'
       AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'No-overflow completed draft left league inactive';
  END IF;

  v_overflow_result := public.make_snake_pick_atomic(
    '00000000-0000-0000-0000-000000010608',
    '00000000-0000-0000-0000-000000010309',
    '00000000-0000-0000-0000-000000010101'
  );
  IF v_overflow_result->>'activated' <> 'false' THEN
    RAISE EXCEPTION 'Overflow completion activated unexpectedly: %', v_overflow_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.drafts
     WHERE id = '00000000-0000-0000-0000-000000010608'
       AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Overflow draft did not complete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.leagues
     WHERE id = '00000000-0000-0000-0000-000000010205'
       AND status = 'drafting'
  ) THEN
    RAISE EXCEPTION 'Overflow completion should leave league in drafting';
  END IF;
END $$;

-- League deletion must be permissioned, audited, and hidden by normal RLS scopes.
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, roster_size, auction_budget)
VALUES ('00000000-0000-0000-0000-000000010203', 'Deletion Behavior League', 'deletion-behavior-league', '00000000-0000-0000-0000-000000010001', 'drafting', 12, 200);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000010305', '00000000-0000-0000-0000-000000010203', '00000000-0000-0000-0000-000000010001', 'commissioner', 'Delete Commish'),
  ('00000000-0000-0000-0000-000000010306', '00000000-0000-0000-0000-000000010203', '00000000-0000-0000-0000-000000010002', 'manager', 'Delete Manager');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES ('00000000-0000-0000-0000-000000010403', '00000000-0000-0000-0000-000000010203', 2099, true);

INSERT INTO public.drafts (id, league_id, league_season_id, draft_type, status, budget_per_team, started_at, pick_timer_seconds, rounds, pause_reason)
VALUES
  ('00000000-0000-0000-0000-000000010604', '00000000-0000-0000-0000-000000010203', '00000000-0000-0000-0000-000000010403', 'auction', 'in_progress', 200, now(), 30, null, NULL),
  ('00000000-0000-0000-0000-000000010605', '00000000-0000-0000-0000-000000010203', '00000000-0000-0000-0000-000000010403', 'snake', 'paused', null, now(), 30, 1, 'manual');

INSERT INTO public.nominations (id, draft_id, nominating_member_id, player_id, nomination_order, status, current_bid_amount, countdown_expires_at)
VALUES ('00000000-0000-0000-0000-000000010901', '00000000-0000-0000-0000-000000010604', '00000000-0000-0000-0000-000000010305', '00000000-0000-0000-0000-000000010103', 1, 'open', 1, now() + interval '30 seconds');

INSERT INTO public.snake_draft_picks (id, draft_id, overall_pick, round, pick_in_round, member_id, timer_expires_at)
VALUES ('00000000-0000-0000-0000-000000010705', '00000000-0000-0000-0000-000000010605', 1, 1, 1, '00000000-0000-0000-0000-000000010305', now() + interval '30 seconds');

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000010002', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM public.delete_league_atomic('00000000-0000-0000-0000-000000010203');
  RAISE EXCEPTION 'Expected non-commissioner delete to fail';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_result jsonb;
  v_visible_count int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000010001', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  v_result := public.delete_league_atomic('00000000-0000-0000-0000-000000010203');
  IF v_result->>'deleted' <> 'true' THEN
    RAISE EXCEPTION 'Commissioner delete returned unexpected result: %', v_result;
  END IF;

  SELECT count(*) INTO v_visible_count FROM public.leagues WHERE id = '00000000-0000-0000-0000-000000010203';
  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'Deleted league remained visible through leagues RLS';
  END IF;

  SELECT count(*) INTO v_visible_count FROM public.drafts WHERE league_id = '00000000-0000-0000-0000-000000010203';
  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'Deleted league drafts remained visible through scoped draft RLS';
  END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_audit_metadata jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.leagues
     WHERE id = '00000000-0000-0000-0000-000000010203'
       AND deleted_by = '00000000-0000-0000-0000-000000010001'
       AND deleted_at IS NOT NULL
       AND status = 'archived'
  ) THEN
    RAISE EXCEPTION 'League was not soft-deleted by commissioner';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.drafts
     WHERE league_id = '00000000-0000-0000-0000-000000010203'
       AND status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'League deletion left active drafts behind';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.drafts
     WHERE league_id = '00000000-0000-0000-0000-000000010203'
       AND pause_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'League deletion left stale draft pause reasons behind';
  END IF;

  SELECT metadata INTO v_audit_metadata
    FROM public.league_audit_logs
   WHERE league_id = '00000000-0000-0000-0000-000000010203'
     AND actor_user_id = '00000000-0000-0000-0000-000000010001'
     AND action = 'delete'
   LIMIT 1;

  IF v_audit_metadata IS NULL OR v_audit_metadata->>'previousStatus' <> 'drafting' THEN
    RAISE EXCEPTION 'League deletion audit metadata incorrect: %', v_audit_metadata;
  END IF;
END $$;

ROLLBACK;
