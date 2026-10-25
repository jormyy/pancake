BEGIN;
\ir rules-support.sql

DO $$
DECLARE
  v_fixture record;
  v_players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  v_roster uuid;
  v_claim uuid;
  v_draft uuid := gen_random_uuid();
  v_old_season uuid := gen_random_uuid();
  v_result record;
  v_error text := 'Drafted rookies are available after your league completes its rookie draft.';
BEGIN
  SELECT * INTO v_fixture FROM pg_temp.rules_fixture(2, 9375, 'offseason');
  PERFORM set_config('request.jwt.claim.sub', v_fixture.user_ids[1]::text, true);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, nba_draft_number)
  SELECT id, 'Rookie', 'Acquisition', 'PG', ARRAY['PG'], CASE WHEN ordinal = 4 THEN 3 ELSE 0 END,
    CASE WHEN ordinal = 5 THEN NULL ELSE ordinal END
  FROM unnest(v_players) WITH ORDINALITY player(id, ordinal);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(v_fixture.league_id, v_fixture.season_id, v_fixture.member_ids[1], v_players[4], 'draft')
  RETURNING id INTO v_roster;
  PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L)',
    v_fixture.member_ids[1], v_fixture.league_id, v_players[1]), v_error, 'free-agent add waits for rookie draft');
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_and_add_free_agent_atomic(%L,%L,%L,%L)',
    v_roster, v_fixture.member_ids[1], v_fixture.league_id, v_players[2]), v_error, 'drop-and-add waits for rookie draft');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE id = v_roster)
    AND NOT EXISTS(SELECT 1 FROM public.roster_transactions WHERE league_season_id = v_fixture.season_id),
    'rejected drop-and-add preserves the dropped player and history');

  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, clears_at)
  VALUES(v_fixture.league_id, v_fixture.season_id, v_players[3], now() + interval '1 hour');
  v_claim := public.create_waiver_claim_atomic(v_fixture.league_id, v_fixture.member_ids[1],
    v_players[3], v_players[4], v_fixture.user_ids[1], 5);
  UPDATE public.waiver_wire_log SET clears_at = now() - interval '1 minute' WHERE league_id = v_fixture.league_id;
  UPDATE public.waiver_claims SET process_date = current_date WHERE id = v_claim;
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(current_date);
  PERFORM pg_temp.check_rules(v_result.claim_id = v_claim AND v_result.status = 'failed_roster'
    AND v_result.failure_reason = v_error, 'waiver award rejects rookie without aborting the batch');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE id = v_roster)
    AND NOT EXISTS(SELECT 1 FROM public.roster_players WHERE player_id = v_players[3])
    AND NOT EXISTS(SELECT 1 FROM public.roster_transactions WHERE league_season_id = v_fixture.season_id)
    AND (SELECT balance = 100 FROM public.faab_balances WHERE member_id = v_fixture.member_ids[1]
      AND league_season_id = v_fixture.season_id), 'rejected award preserves drop, FAAB, and history');

  INSERT INTO public.league_seasons(id, league_id, season_year, is_current)
  VALUES(v_old_season, v_fixture.league_id, 9374, false);
  INSERT INTO public.drafts(league_id, league_season_id, draft_type, status, is_mock)
  VALUES(v_fixture.league_id, v_old_season, 'snake', 'completed', false),
    (v_fixture.league_id, v_fixture.season_id, 'snake', 'completed', true),
    (v_fixture.league_id, v_fixture.season_id, 'auction', 'completed', false);
  PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L)',
    v_fixture.member_ids[1], v_fixture.league_id, v_players[1]), v_error,
    'old-season, mock, and auction drafts do not unlock rookies');
  INSERT INTO public.drafts(id, league_id, league_season_id, draft_type, status, is_mock)
  VALUES(v_draft, v_fixture.league_id, v_fixture.season_id, 'snake', 'pending', false);
  PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L)',
    v_fixture.member_ids[1], v_fixture.league_id, v_players[1]), v_error, 'pending rookie draft does not unlock rookies');
  UPDATE public.drafts SET status = 'in_progress' WHERE id = v_draft;
  PERFORM pg_temp.reject_rules(format('SELECT public.add_free_agent_atomic(%L,%L,%L)',
    v_fixture.member_ids[1], v_fixture.league_id, v_players[1]), v_error, 'running rookie draft does not unlock rookies');

  PERFORM public.add_free_agent_atomic(v_fixture.member_ids[1], v_fixture.league_id, v_players[5]);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE league_season_id = v_fixture.season_id
    AND player_id = v_players[5]), 'undrafted rookies remain available in offseason');
  UPDATE public.drafts SET status = 'completed' WHERE id = v_draft;
  UPDATE public.leagues SET status = 'offseason' WHERE id = v_fixture.league_id;
  PERFORM public.add_free_agent_atomic(v_fixture.member_ids[1], v_fixture.league_id, v_players[1]);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE league_season_id = v_fixture.season_id
    AND player_id = v_players[1]), 'completed current rookie draft unlocks offseason free agents');
  DELETE FROM public.waiver_claims WHERE id = v_claim;
  UPDATE public.waiver_wire_log SET clears_at = now() + interval '1 hour' WHERE league_id = v_fixture.league_id;
  v_claim := public.create_waiver_claim_atomic(v_fixture.league_id, v_fixture.member_ids[1],
    v_players[3], NULL, v_fixture.user_ids[1], 5);
  UPDATE public.waiver_wire_log SET clears_at = now() - interval '1 minute' WHERE league_id = v_fixture.league_id;
  UPDATE public.waiver_claims SET process_date = current_date WHERE id = v_claim;
  SELECT * INTO v_result FROM public.process_next_waiver_claim_atomic(current_date);
  PERFORM pg_temp.check_rules(v_result.claim_id = v_claim AND v_result.status = 'succeeded',
    'completed current rookie draft unlocks waiver awards');
  UPDATE public.leagues SET status = 'active' WHERE id = v_fixture.league_id;
  UPDATE public.drafts SET status = 'cancelled' WHERE id = v_draft;
  PERFORM public.add_free_agent_atomic(v_fixture.member_ids[1], v_fixture.league_id, v_players[2]);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE league_season_id = v_fixture.season_id
    AND player_id = v_players[2]), 'active-season rookie adds keep existing rules');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
