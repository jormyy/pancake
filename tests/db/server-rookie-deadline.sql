BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  draft uuid;
  game uuid;
  players uuid[];
  newest uuid;
  slots int;
BEGIN
  FOR slots IN 0..1 LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2, 9500 + slots, 'drafting');
    draft := gen_random_uuid();
    game := gen_random_uuid();
    players := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
    UPDATE public.leagues SET roster_size = 1, taxi_slots = slots WHERE id = f.league_id;
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES(game, '002950000' || slots, 9500 + slots, 1, (now() AT TIME ZONE 'America/New_York')::date + 1, 'RDA', 'RDB', 'Scheduled');
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, nba_draft_number)
    SELECT id, 'Deadline', id::text, 'PG', ARRAY['PG'], CASE WHEN ord IN (1, 4) THEN 4 ELSE 0 END, 1
    FROM unnest(players) WITH ORDINALITY AS player(id, ord);
    INSERT INTO public.drafts(id, league_id, league_season_id, draft_type, status, is_mock, rounds)
    VALUES(draft, f.league_id, f.season_id, 'snake', 'completed', false, 2);
    INSERT INTO public.snake_draft_picks(draft_id, overall_pick, round, pick_in_round, member_id, player_id, picked_at)
    VALUES(draft, 1, 1, 1, f.member_ids[1], players[2], now() - interval '2 minutes'),
      (draft, 2, 1, 2, f.member_ids[2], players[5], now() - interval '1 minute'),
      (draft, 3, 2, 1, f.member_ids[1], players[3], now());
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[CASE WHEN ord <= 3 THEN 1 ELSE 2 END], id, 'draft'
    FROM unnest(players) WITH ORDINALITY AS player(id, ord);
    PERFORM pg_temp.check_rules(NOT public.activate_rookie_draft_league_atomic(p_draft_id => draft),
      'overflow waits before opening night with taxi slots ' || slots);
    UPDATE public.nba_games SET game_date = (now() AT TIME ZONE 'America/New_York')::date - 1 WHERE id = game;
    PERFORM pg_temp.check_rules(public.activate_rookie_draft_league_atomic(p_draft_id => draft),
      'opening night activates despite remaining overflow with taxi slots ' || slots);
    PERFORM pg_temp.check_rules((SELECT status = 'active' FROM public.leagues WHERE id = f.league_id),
      'deadline leaves the league active with taxi slots ' || slots);
    PERFORM pg_temp.check_rules((SELECT count(*) = slots * 2 FROM public.roster_players
      WHERE league_season_id = f.season_id AND is_on_taxi), 'deadline respects taxi capacity ' || slots);
    IF slots = 1 THEN
      PERFORM pg_temp.check_rules((SELECT is_on_taxi FROM public.roster_players
        WHERE league_season_id = f.season_id AND player_id = players[3])
        AND NOT (SELECT is_on_taxi FROM public.roster_players WHERE league_season_id = f.season_id AND player_id = players[2]),
        'deadline moves the newest drafted rookie first');
    END IF;
    PERFORM pg_temp.reject_rules(format('SELECT private.assert_roster_within_active_limit(%L,%L,%L)',
      f.league_id, f.season_id, f.member_ids[1]), '%active player limit%', 'deadline overflow still blocks roster edits with slots ' || slots);
    PERFORM pg_temp.check_rules(NOT public.activate_rookie_draft_league_atomic(p_draft_id => draft),
      'deadline activation is idempotent with taxi slots ' || slots);
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
