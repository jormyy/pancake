BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  players uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid()];
  payload jsonb;
  offer uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9384);
  UPDATE public.leagues SET allow_inactive_trades = true, roster_size = 1 WHERE id = f.league_id;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions)
  SELECT id, 'Plan', id::text, 'PG', ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES(f.league_id, f.season_id, f.member_ids[1], players[1], 'draft'),
    (f.league_id, f.season_id, f.member_ids[2], players[2], 'draft');
  payload := jsonb_build_object('leagueId', f.league_id, 'leagueSeasonId', f.season_id,
    'recipientMemberId', f.member_ids[2], 'offerPlayerIds', '[]'::jsonb, 'requestPlayerIds', ARRAY[players[2]],
    'offerPickIds', '[]'::jsonb, 'requestPickIds', '[]'::jsonb, 'notes', NULL, 'expiresAt', NULL,
    'offerFaabAmount', 1, 'requestFaabAmount', 0);
  PERFORM pg_temp.reject_rules(format('SELECT public.submit_trade_offer_atomic(%L,%L,%L,%L,%L)',
    f.user_ids[1], gen_random_uuid(), f.member_ids[1], 'propose', payload),
    'Rules team 1: Regular roster is % over the limit of %',
    'sending without a plan rejects proposer overflow by team name');
  payload := payload || jsonb_build_object('rosterPlan', jsonb_build_object(
    'taxiPlayerIds', '[]'::jsonb, 'irPlayerIds', '[]'::jsonb, 'dropPlayerIds', ARRAY[players[1]]));
  offer := public.submit_trade_offer_atomic(f.user_ids[1], gen_random_uuid(), f.member_ids[1], 'propose', payload);
  PERFORM pg_temp.check_rules(offer IS NOT NULL AND EXISTS(SELECT 1 FROM public.trade_participants
    WHERE trade_id = offer AND member_id = f.member_ids[1] AND players[1] = ANY(drop_player_ids)),
    'the exact API payload applies a valid plan before validation');
  PERFORM pg_temp.check_rules((SELECT count(*) = 2 FROM public.roster_players WHERE league_season_id = f.season_id),
    'sending a valid plan leaves both rosters intact');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
