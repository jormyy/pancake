BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Restores the tipoff-only first forecast from 20261214006300_schedule_half_gig.sql.
CREATE OR REPLACE VIEW private.matchup_forecast_schedule AS
SELECT matchup.id AS matchup_id,CASE WHEN matchup.is_finalized THEN CASE WHEN NOT COALESCE(queued.finalized,false) THEN now() END
    WHEN EXISTS(SELECT 1 FROM public.nba_games game WHERE game.season_year=season.season_year
      AND game.game_date BETWEEN first_week.week_start AND last_week.week_end AND game.status='InProgress')
      THEN GREATEST(now(),cached.calculated_at+interval '30 minutes')
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

COMMIT;
