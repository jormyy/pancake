-- Canonical SQL source for private.refresh_live_matchup_totals.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.refresh_live_matchup_totals()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE refreshed integer;
BEGIN
  WITH ready AS MATERIALIZED (
    SELECT matchup_id,revision FROM private.live_matchup_refresh_queue
    ORDER BY revision,matchup_id LIMIT 8 FOR UPDATE SKIP LOCKED
  ), written AS (
    INSERT INTO public.matchup_totals AS cached(matchup_id,league_id,league_season_id,
      home_points,away_points,home_max_possible_points,away_max_possible_points,version)
    SELECT matchup.id,matchup.league_id,matchup.league_season_id,matchup.home_points,matchup.away_points,
      matchup.home_max_possible_points,matchup.away_max_possible_points,COALESCE(screen.version,1)
    FROM ready JOIN public.matchups matchup ON matchup.id=ready.matchup_id
    JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
    JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
    JOIN public.season_weeks last_week ON last_week.season_year=season.season_year AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
    LEFT JOIN private.screen_refresh_queue screen ON screen.league_season_id=season.id
    WHERE NOT matchup.is_voided AND (now() AT TIME ZONE 'America/New_York')::date BETWEEN first_week.week_start AND last_week.week_end
      AND EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
        AND game.game_date=(now() AT TIME ZONE 'America/New_York')::date
        AND game.status IN('InProgress','Final') AND public.is_regular_season_game_id(game.nba_game_id))
    ORDER BY matchup.id
    ON CONFLICT(matchup_id) DO UPDATE SET home_points=EXCLUDED.home_points,away_points=EXCLUDED.away_points,
      home_max_possible_points=EXCLUDED.home_max_possible_points,away_max_possible_points=EXCLUDED.away_max_possible_points,
      version=GREATEST(cached.version,EXCLUDED.version),refreshed_at=now()
    WHERE ROW(cached.home_points,cached.away_points,cached.home_max_possible_points,cached.away_max_possible_points)
      IS DISTINCT FROM ROW(EXCLUDED.home_points,EXCLUDED.away_points,EXCLUDED.home_max_possible_points,EXCLUDED.away_max_possible_points)
    RETURNING matchup_id
  ) DELETE FROM private.live_matchup_refresh_queue queued USING ready
    WHERE queued.matchup_id=ready.matchup_id AND queued.revision=ready.revision;
  GET DIAGNOSTICS refreshed=ROW_COUNT;
  RETURN refreshed;
END;
$$;
