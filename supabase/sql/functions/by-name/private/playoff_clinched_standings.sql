CREATE OR REPLACE FUNCTION private.playoff_clinched_standings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  season record;
  clincher record;
  team_count int;
  entrants int;
BEGIN
  FOR season IN
    SELECT DISTINCT s.id, s.league_id, s.season_year, s.skipped_weeks,
      l.playoff_start_week, l.playoff_entrants
    FROM clinch_standings changed
    JOIN public.league_seasons s ON s.id = changed.league_season_id AND s.league_id = changed.league_id
    JOIN public.leagues l ON l.id = s.league_id
    WHERE s.is_current AND l.status = 'active'
      AND changed.week_number < l.playoff_start_week
      AND NOT (changed.week_number = ANY(s.skipped_weeks))
  LOOP
    SELECT count(*) INTO team_count FROM public.league_members WHERE league_id = season.league_id;
    entrants := COALESCE(season.playoff_entrants, CASE WHEN team_count >= 10 THEN 6 ELSE 4 END);
    IF entrants < 2 OR entrants > team_count THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM generate_series(1, season.playoff_start_week - 1) expected(week_number)
      LEFT JOIN public.season_weeks w ON w.season_year = season.season_year AND w.week_number = expected.week_number
      WHERE NOT (expected.week_number = ANY(season.skipped_weeks)) AND w.id IS NULL
    ) THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT w.week_number
      FROM public.season_weeks w
      LEFT JOIN public.matchups m ON m.league_season_id = season.id AND m.week_number = w.week_number
        AND m.matchup_type = 'regular_season'
      WHERE w.season_year = season.season_year AND w.week_number < season.playoff_start_week
        AND NOT (w.week_number = ANY(season.skipped_weeks))
      GROUP BY w.week_number HAVING count(m.id) <> team_count / 2
    ) THEN CONTINUE; END IF;
    FOR clincher IN
      WITH bounds AS MATERIALIZED (
        SELECT ranking.*,
          count(matchup.id) FILTER (WHERE NOT matchup.is_finalized) AS remaining
        FROM private.playoff_seed_rankings(season.league_id, season.id, season.playoff_start_week) ranking
        LEFT JOIN public.matchups matchup ON matchup.league_season_id = season.id
          AND matchup.matchup_type = 'regular_season'
          AND matchup.week_number < season.playoff_start_week
          AND NOT (matchup.week_number = ANY(season.skipped_weeks))
          AND NOT matchup.is_voided
          AND ranking.member_id IN (matchup.home_member_id, matchup.away_member_id)
        GROUP BY ranking.member_id, ranking.wins, ranking.ties, ranking.games_played, ranking.points_for, ranking.max_possible_points,
          ranking.points_against, ranking.tie_token, ranking.seed_rank, ranking.group_start
      )
      SELECT candidate.member_id FROM bounds candidate
      WHERE CASE WHEN NOT EXISTS (SELECT 1 FROM bounds WHERE remaining > 0)
        THEN candidate.seed_rank <= entrants
        ELSE (SELECT count(*) FROM bounds opponent WHERE opponent.member_id <> candidate.member_id
          AND (opponent.wins + 0.5 * opponent.ties + opponent.remaining) / greatest(opponent.games_played + opponent.remaining, 1)
            >= (candidate.wins + 0.5 * candidate.ties) / greatest(candidate.games_played + candidate.remaining, 1)) < entrants
        END
    LOOP
      PERFORM private.notif_enqueue('playoff_clinched', season.id::text, season.league_id, clincher.member_id,
        jsonb_build_object('leagueSeasonId', season.id, 'seasonYear', season.season_year,
          'playoffEntrants', entrants, 'phase', 'qualification', 'body', 'Your team has clinched a playoff spot.'));
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;
