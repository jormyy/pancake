BEGIN;

CREATE FUNCTION pg_temp.check_certification(p_ok boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', p_message; END IF;
END;
$$;

DO $$
DECLARE
  game uuid := gen_random_uuid();
  active_player uuid := gen_random_uuid();
  inactive_player uuid := gen_random_uuid();
  provider text := '002-certification-' || game;
  stats jsonb;
  removed_row jsonb;
  changed integer;
  rejected boolean := false;
  revision timestamptz := clock_timestamp();
BEGIN
  INSERT INTO public.players(id, first_name, last_name)
  VALUES(active_player, 'Active', 'Certification'), (inactive_player, 'Inactive', 'Certification');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
  VALUES(game, provider, 2099, 1, '2098-10-28', 'DAL', 'OKC', 'InProgress');
  INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number,
    minutes_played, points, rebounds, offensive_rebounds, defensive_rebounds, assists, steals,
    blocks, turnovers, personal_fouls, field_goals_made, field_goals_attempted, three_pointers_made,
    three_pointers_attempted, free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double, did_not_play)
  VALUES(inactive_player, game, 2099, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false, true);
  stats := jsonb_build_array(jsonb_build_object('player_id', active_player, 'game_id', game,
    'did_not_play', false, 'minutes_played', 30, 'points', 25));
  SELECT to_jsonb(s) INTO removed_row FROM public.player_game_stats s WHERE game_id=game;
  BEGIN
    PERFORM public.save_final_game_snapshot_atomic(game, provider,
      stats || jsonb_build_array(jsonb_build_object('player_id', gen_random_uuid(), 'game_id', game,
        'did_not_play', false, 'minutes_played', 1, 'points', 2)), revision, 100, 90, 'Final');
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  PERFORM pg_temp.check_certification(rejected, 'A bad player must fail after the cleanup');
  PERFORM pg_temp.check_certification((SELECT to_jsonb(s)=removed_row FROM public.player_game_stats s
    WHERE game_id=game AND player_id=inactive_player), 'A later failure restores the exact removed row');
  PERFORM pg_temp.check_certification(NOT EXISTS(SELECT FROM public.sync_runs WHERE details->>'game_id'=game::text),
    'A later failure rolls back the cleanup receipt');
  PERFORM pg_temp.check_certification((SELECT status='InProgress' AND stats_synced_at IS NULL FROM public.nba_games WHERE id=game),
    'A later failure rolls back certification');
  changed := public.save_final_game_snapshot_atomic(game, provider, stats, revision, 100, 90, 'Final');
  PERFORM pg_temp.check_certification(changed=1, 'Changed count preserves the inserted and updated row contract');
  PERFORM pg_temp.check_certification(NOT EXISTS(SELECT FROM public.player_game_stats WHERE game_id=game AND player_id=inactive_player),
    'Absent inactive zero row must be deleted');
  PERFORM pg_temp.check_certification((SELECT status='Final' AND stats_synced_at IS NOT NULL FROM public.nba_games WHERE id=game),
    'Absent inactive zero row must not block certification');
  PERFORM pg_temp.check_certification((SELECT count(*)=1 AND bool_and(rows_affected=1 AND
    details->'removed_inactive_rows'=jsonb_build_array(removed_row)) FROM public.sync_runs
    WHERE details->>'game_id'=game::text), 'The transaction records the exact removed row in its run receipt');
  PERFORM pg_temp.check_certification((SELECT revision_at=revision FROM private.game_stat_revisions WHERE game_id=game),
    'The final revision commits with the cleanup');
  PERFORM pg_temp.check_certification(public.save_final_game_snapshot_atomic(game, provider, stats, revision, 100, 90, 'Final')=0,
    'An identical revision changes no rows');
  PERFORM pg_temp.check_certification((SELECT count(*)=1 FROM public.sync_runs WHERE details->>'game_id'=game::text),
    'An identical revision does not duplicate the cleanup receipt');
END;
$$;

\echo 'PASS: absent inactive zero row is deleted, certified, and receipted'

DO $$
DECLARE
  game uuid := gen_random_uuid();
  active_player uuid := gen_random_uuid();
  missing_player uuid := gen_random_uuid();
  inactive_player uuid := gen_random_uuid();
  provider text := '002-certification-' || game;
  stats jsonb;
  before_rows jsonb;
  before_game jsonb;
  field text;
  value jsonb;
  scenario jsonb;
  rejected boolean;
BEGIN
  INSERT INTO public.players(id, first_name, last_name)
  VALUES(active_player, 'Active', 'Guard'), (missing_player, 'Missing', 'Guard'), (inactive_player, 'Inactive', 'Guard');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, home_score, away_score)
  VALUES(game, provider, 2099, 2, '2098-10-29', 'DAL', 'OKC', 'InProgress', 20, 19);
  INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number,
    minutes_played, points, rebounds, offensive_rebounds, defensive_rebounds, assists, steals,
    blocks, turnovers, personal_fouls, field_goals_made, field_goals_attempted, three_pointers_made,
    three_pointers_attempted, free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double, did_not_play)
  SELECT player, game, 2099, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false, true
  FROM unnest(ARRAY[missing_player, inactive_player]) player;
  stats := jsonb_build_array(jsonb_build_object('player_id', active_player, 'game_id', game,
    'did_not_play', false, 'minutes_played', 30, 'points', 25));
  FOR scenario IN SELECT jsonb_build_object(key, CASE WHEN key IN ('double_double','triple_double') THEN 'true'::jsonb
      WHEN key='did_not_play' THEN 'false'::jsonb ELSE '1'::jsonb END)
    FROM unnest(ARRAY['minutes_played','points','rebounds','offensive_rebounds','defensive_rebounds','assists',
      'steals','blocks','turnovers','personal_fouls','field_goals_made','field_goals_attempted','three_pointers_made',
      'three_pointers_attempted','free_throws_made','free_throws_attempted','plus_minus','double_double','triple_double','did_not_play']) key
    UNION ALL SELECT '{"plus_minus":-1}'::jsonb
    UNION ALL SELECT '{"minutes_played":0.01}'::jsonb
    UNION ALL SELECT '{"minutes_played":null}'::jsonb
    UNION ALL SELECT '{"points":null}'::jsonb
  LOOP
    SELECT key, val INTO field, value FROM jsonb_each(scenario) entry(key, val);
    EXECUTE format('UPDATE public.player_game_stats SET %I=%L WHERE player_id=%L AND game_id=%L', field, value #>> '{}', missing_player, game);
    SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) INTO before_rows FROM public.player_game_stats s WHERE game_id=game;
    SELECT to_jsonb(g) INTO before_game FROM public.nba_games g WHERE id=game;
    rejected := false;
    BEGIN
      PERFORM public.save_final_game_snapshot_atomic(game, provider, stats, clock_timestamp(), 100, 90, 'Final');
    EXCEPTION WHEN SQLSTATE '22023' THEN
      rejected := SQLERRM='The complete box score omits stored players. Resolve the game inputs before certifying it.';
    END;
    PERFORM pg_temp.check_certification(rejected, 'Missing nonzero, played, or unknown row must fail: ' || scenario::text);
    PERFORM pg_temp.check_certification((SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id)=before_rows
      FROM public.player_game_stats s WHERE game_id=game), 'Rejection rolls back all deletions and stats');
    PERFORM pg_temp.check_certification((SELECT to_jsonb(g)=before_game FROM public.nba_games g WHERE id=game),
      'Rejection rolls back scores and certification');
    PERFORM pg_temp.check_certification(NOT EXISTS(SELECT FROM private.game_stat_revisions WHERE game_id=game),
      'Rejection does not save a revision');
    PERFORM pg_temp.check_certification(NOT EXISTS(SELECT FROM public.sync_runs WHERE details->>'game_id'=game::text),
      'Rejection does not save a cleanup receipt');
    EXECUTE format('UPDATE public.player_game_stats SET %I=%L WHERE player_id=%L AND game_id=%L', field,
      CASE WHEN field='did_not_play' THEN 'true' WHEN field IN ('double_double','triple_double') THEN 'false' ELSE '0' END, missing_player, game);
  END LOOP;
END;
$$;

\echo 'PASS: 24 missing-row controls fail and roll back cleanup, scores, revision, and receipt'

ROLLBACK;
