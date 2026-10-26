BEGIN;
\ir rules-support.sql
CREATE FUNCTION pg_temp.rookie_award(p_league uuid, p_member uuid, p_user uuid, p_player uuid, p_drop uuid DEFAULT NULL)
RETURNS TABLE(claim_id uuid, status public.waiver_claim_status, failure_reason text)
LANGUAGE plpgsql AS $$
DECLARE v_claim uuid;
BEGIN
  v_claim := public.create_waiver_claim_atomic(p_league, p_member, p_player, p_drop, p_user, 5);
  UPDATE public.waiver_claims SET process_date = (now() AT TIME ZONE 'America/New_York')::date - 1 WHERE id = v_claim;
  UPDATE public.waiver_wire_log SET clears_at = now() - interval '3 days'
    WHERE league_id = p_league AND player_id = p_player AND cleared_at IS NULL;
  RETURN QUERY SELECT outcome.claim_id, outcome.status, outcome.failure_reason
    FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/New_York')::date) outcome;
END;
$$;
DO $$
DECLARE
  f record;
  players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  draft uuid := gen_random_uuid();
  old_season uuid := gen_random_uuid();
  scenario text;
  outcome record;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9375, 'offseason');
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, nba_draft_number)
    SELECT id, 'Rookie', 'Acquisition', 'PG', ARRAY['PG'], CASE WHEN ordinal = 4 THEN 3 ELSE 0 END,
      CASE WHEN ordinal = 3 THEN NULL ELSE ordinal END
    FROM unnest(players) WITH ORDINALITY player(id, ordinal);
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], players[4], 'draft');
  FOREACH scenario IN ARRAY ARRAY['missing', 'old-mock-auction', 'pending', 'in_progress'] LOOP
    IF scenario = 'old-mock-auction' THEN
      INSERT INTO public.league_seasons(id, league_id, season_year, is_current) VALUES(old_season, f.league_id, 9374, false);
      INSERT INTO public.drafts(league_id, league_season_id, draft_type, status, is_mock)
        VALUES(f.league_id, old_season, 'snake', 'completed', false),
          (f.league_id, f.season_id, 'snake', 'completed', true),
          (f.league_id, f.season_id, 'auction', 'completed', false);
    ELSIF scenario = 'pending' THEN
      INSERT INTO public.drafts(id, league_id, league_season_id, draft_type, status, is_mock)
        VALUES(draft, f.league_id, f.season_id, 'snake', 'pending', false);
    ELSIF scenario = 'in_progress' THEN
      UPDATE public.drafts SET status = 'in_progress' WHERE id = draft;
    END IF;
    SELECT * INTO outcome FROM pg_temp.rookie_award(f.league_id, f.member_ids[1], f.user_ids[1], players[1], players[4]);
    PERFORM pg_temp.check_rules(outcome.status = 'failed_roster'
      AND outcome.failure_reason = 'Drafted rookies are available after your league completes its rookie draft.',
      scenario || ' rookie draft blocks its scheduled award');
    PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE player_id = players[4])
      AND NOT EXISTS(SELECT 1 FROM public.roster_players WHERE player_id = players[1])
      AND NOT EXISTS(SELECT 1 FROM public.roster_transactions WHERE league_season_id = f.season_id)
      AND (SELECT balance = 100 FROM public.faab_balances WHERE member_id = f.member_ids[1] AND league_season_id = f.season_id),
      scenario || ' rejected award preserves its drop, funds, and history');
  END LOOP;
  SELECT * INTO outcome FROM pg_temp.rookie_award(f.league_id, f.member_ids[1], f.user_ids[1], players[3]);
  PERFORM pg_temp.check_rules(outcome.status = 'succeeded'
    AND EXISTS(SELECT 1 FROM public.roster_players WHERE player_id = players[3]),
    'undrafted rookies remain available before the rookie draft completes');
  UPDATE public.drafts SET status = 'completed' WHERE id = draft;
  SELECT * INTO outcome FROM pg_temp.rookie_award(f.league_id, f.member_ids[1], f.user_ids[1], players[1], players[4]);
  PERFORM pg_temp.check_rules(outcome.status = 'succeeded'
    AND EXISTS(SELECT 1 FROM public.roster_players WHERE player_id = players[1])
    AND NOT EXISTS(SELECT 1 FROM public.roster_players WHERE player_id = players[4]),
    'completed current rookie draft unlocks the award and its selected drop');
  UPDATE public.leagues SET status = 'active' WHERE id = f.league_id;
  UPDATE public.drafts SET status = 'cancelled' WHERE id = draft;
  SELECT * INTO outcome FROM pg_temp.rookie_award(f.league_id, f.member_ids[1], f.user_ids[1], players[2]);
  PERFORM pg_temp.check_rules(outcome.status = 'succeeded'
    AND EXISTS(SELECT 1 FROM public.roster_players WHERE player_id = players[2]),
    'active-season rookie awards remain available');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
