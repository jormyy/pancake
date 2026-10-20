BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.invoke_live_poll_if_due()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.live_poll_leases WHERE lock_key = 779001 AND expires_at > clock_timestamp()) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_live_poll_work()) THEN
    PERFORM public.invoke_edge_function('live-poll');
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.edge_invocations
    WHERE function_name = 'sync-scores' AND queued_at > clock_timestamp() - interval '30 minutes') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.league_seasons season
    JOIN public.leagues league ON league.id = season.league_id
    JOIN public.matchups matchup ON matchup.league_season_id = season.id
    JOIN public.season_weeks week ON week.season_year = season.season_year
      AND week.week_number = COALESCE(matchup.end_week_number, matchup.week_number)
    WHERE season.is_current AND league.status = 'active' AND NOT matchup.is_voided
      AND NOT (matchup.week_number = ANY(season.skipped_weeks))
      AND NOT EXISTS (SELECT 1 FROM private.retired_score_inputs retired WHERE retired.league_season_id = season.id)
      AND week.week_end <= (clock_timestamp() AT TIME ZONE 'America/New_York')::date
      AND (NOT matchup.is_finalized
        OR week.week_end >= (clock_timestamp() AT TIME ZONE 'America/New_York')::date - 4
        OR EXISTS (SELECT 1 FROM public.get_stale_score_weeks(season.id, matchup.week_number)))
  ) THEN
    PERFORM public.invoke_edge_function('sync-scores');
  END IF;
END;
$$;

COMMIT;
