BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- A week's first forecast used to wait for its first tipoff, so every matchup read "pending" from the week flip
-- until the first game. A started week's matchup with no saved forecast is now due at once; after that first
-- forecast it keeps the tipoff and in-game refresh schedule, so this costs one computation per matchup per week.
CREATE OR REPLACE VIEW private.matchup_forecast_schedule AS
SELECT matchup.id AS matchup_id,CASE WHEN matchup.is_finalized THEN CASE WHEN NOT COALESCE(queued.finalized,false) THEN now() END
    WHEN EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date BETWEEN first_week.week_start AND last_week.week_end AND game.status='InProgress')
      THEN GREATEST(now(),cached.calculated_at+interval '30 minutes')
    WHEN cached.matchup_id IS NULL AND first_week.week_start<=(now() AT TIME ZONE 'America/New_York')::date THEN now()
    ELSE (SELECT min(game.game_time) FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date BETWEEN first_week.week_start AND last_week.week_end
      AND game.status NOT IN ('Final','Cancelled','Postponed') AND game.game_time>now()) END AS due_at
  FROM public.matchups matchup
  JOIN public.league_seasons season ON season.id=matchup.league_season_id AND season.is_current
  JOIN public.leagues league ON league.id=matchup.league_id AND league.deleted_at IS NULL
  JOIN public.season_weeks first_week ON first_week.season_year=season.season_year AND first_week.week_number=matchup.week_number
  JOIN public.season_weeks last_week ON last_week.season_year=season.season_year
    AND last_week.week_number=COALESCE(matchup.end_week_number,matchup.week_number)
  LEFT JOIN public.matchup_forecasts cached ON cached.matchup_id=matchup.id
  LEFT JOIN private.matchup_forecast_queue queued ON queued.matchup_id=matchup.id
  WHERE NOT matchup.is_voided;
REVOKE ALL ON private.matchup_forecast_schedule FROM PUBLIC,anon,authenticated,service_role;

-- Refresh requests already parked at a later tipoff for such matchups become due now.
UPDATE private.forecast_refresh_requests request SET available_at=now()
  FROM private.matchup_forecast_schedule schedule
  WHERE schedule.matchup_id=request.matchup_id AND schedule.due_at<=now() AND request.available_at>now();

COMMIT;
