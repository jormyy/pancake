\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE refill_fixture AS SELECT * FROM pg_temp.rules_fixture(2, 9197);
DO $$
DECLARE
  f record; p1 uuid := gen_random_uuid(); p2 uuid := gen_random_uuid(); p3 uuid := gen_random_uuid();
  p4 uuid := gen_random_uuid(); claimed record; first_requested timestamptz; running_id bigint;
BEGIN
  SELECT * INTO f FROM refill_fixture;
  DELETE FROM private.work_items WHERE kind = 'lineup-refill';
  DELETE FROM private.lineup_refill_requests;
  DELETE FROM public.lineup_optimizer_settings WHERE league_id = f.league_id;
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled)
  VALUES (f.league_id, f.season_id, f.member_ids[1], true), (f.league_id, f.season_id, f.member_ids[2], false);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, nba_team) VALUES
    (p1, 'Refill', 'One', 'PG', ARRAY['PG'], 'RF1'), (p2, 'Refill', 'Two', 'C', ARRAY['C'], 'RF1'),
    (p3, 'Refill', 'Three', 'SF', ARRAY['SF'], 'RF2'), (p4, 'Refill', 'Four', 'PF', ARRAY['PF'], 'RF2');

  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES (f.league_id, f.season_id, f.member_ids[1], p1, 'draft');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.lineup_refill_requests WHERE member_id = f.member_ids[1]),
    'adding a player asks to refill an auto-set team');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.work_items WHERE kind = 'lineup-refill' AND status = 'pending'
    AND payload->>'mode' = 'roster_refill' AND due_at > now()), 'one delayed refill job is queued');

  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES (f.league_id, f.season_id, f.member_ids[1], p2, 'draft'), (f.league_id, f.season_id, f.member_ids[1], p3, 'draft');
  DELETE FROM public.roster_players WHERE player_id = p1;
  UPDATE public.roster_players SET is_on_ir = true WHERE player_id = p2;
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.lineup_refill_requests), 'a burst of roster changes keeps one request');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.work_items WHERE kind = 'lineup-refill'), 'a burst of roster changes keeps one job');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM public.roster_players WHERE player_id = p1)
    AND (SELECT is_on_ir FROM public.roster_players WHERE player_id = p2), 'roster writes still land');

  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES (f.league_id, f.season_id, f.member_ids[2], p4, 'draft');
  DELETE FROM public.roster_players WHERE player_id = p4;
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM private.lineup_refill_requests WHERE member_id = f.member_ids[2]),
    'a team with auto-set off is left alone');

  UPDATE private.work_items SET status = 'running', lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes'
   WHERE kind = 'lineup-refill' RETURNING id INTO running_id;
  SELECT * INTO claimed FROM public.claim_lineup_refills(5);
  PERFORM pg_temp.check_rules(claimed.member_id = f.member_ids[1] AND claimed.league_season_id = f.season_id,
    'the worker claims the waiting team');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM public.claim_lineup_refills(5)), 'a claimed team is not handed out twice');
  first_requested := claimed.requested_at;

  UPDATE public.roster_players SET is_on_ir = false WHERE player_id = p2;
  PERFORM pg_temp.check_rules((SELECT requested_at > first_requested FROM private.lineup_refill_requests WHERE member_id = f.member_ids[1]),
    'a change during a refill is remembered');
  PERFORM public.complete_lineup_refill(f.member_ids[1], first_requested);
  PERFORM pg_temp.check_rules((SELECT claimed_at IS NULL FROM private.lineup_refill_requests WHERE member_id = f.member_ids[1]),
    'finishing an outdated refill keeps the newer request');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.work_items WHERE kind = 'lineup-refill' AND status = 'pending' AND id <> running_id),
    'a change during a refill queues a follow-up job');

  SELECT * INTO claimed FROM public.claim_lineup_refills(5);
  PERFORM public.complete_lineup_refill(claimed.member_id, claimed.requested_at);
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM private.lineup_refill_requests), 'a finished refill clears its request');

  DELETE FROM public.roster_players WHERE player_id = p3;
  UPDATE public.lineup_optimizer_settings SET enabled = false WHERE member_id = f.member_ids[1];
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM private.lineup_refill_requests), 'a drop while auto-set is on is waiting');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM public.claim_lineup_refills(5)), 'a team that turned auto-set off is not refilled');
  PERFORM pg_temp.check_rules(NOT EXISTS (SELECT 1 FROM private.lineup_refill_requests), 'turning auto-set off drops a waiting refill');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
SELECT label FROM rules_checks ORDER BY label;
ROLLBACK;
