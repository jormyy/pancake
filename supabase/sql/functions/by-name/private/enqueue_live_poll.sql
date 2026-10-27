CREATE OR REPLACE FUNCTION private.enqueue_live_poll(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.live_poll_leases WHERE lock_key = 779001 AND expires_at > p_now) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_live_poll_work(p_now)) THEN
    PERFORM private.work_enqueue('live-poll',date_trunc('minute',p_now)::text,p_now);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.edge_invocations
    WHERE function_name = 'sync-scores' AND queued_at > p_now - interval '30 minutes') THEN
    RETURN;
  END IF;
  IF EXISTS (
    WITH candidates AS MATERIALIZED (
      SELECT season.id, matchup.week_number, week.week_end, bool_and(matchup.is_finalized) AS is_finalized
      FROM public.league_seasons season
      JOIN public.leagues league ON league.id = season.league_id
      JOIN public.matchups matchup ON matchup.league_season_id = season.id
      JOIN public.season_weeks week ON week.season_year = season.season_year
        AND week.week_number = COALESCE(matchup.end_week_number, matchup.week_number)
      WHERE season.is_current AND league.status IN ('active', 'playoffs') AND NOT matchup.is_voided
        AND (matchup.matchup_type = 'regular_season' OR NOT private.playoff_matchup_is_consumed(matchup.id))
        AND NOT EXISTS (SELECT 1 FROM public.matchups final
          WHERE final.league_season_id = season.id AND final.matchup_type = 'playoff_final'
            AND final.is_finalized AND NOT final.is_voided)
        AND NOT (matchup.week_number = ANY(season.skipped_weeks))
        AND NOT EXISTS (SELECT 1 FROM private.retired_score_inputs retired WHERE retired.league_season_id = season.id)
        AND week.week_end <= (p_now AT TIME ZONE 'America/New_York')::date
      GROUP BY season.id, matchup.week_number, week.week_end
    ), season_tokens AS MATERIALIZED (
      SELECT candidate.id,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM public.matchups stored WHERE stored.league_season_id = candidate.id
            AND stored.matchup_type <> 'regular_season'
        ) THEN private.score_input_token(candidate.id, max(candidate.week_number)) END AS input_token
      FROM candidates candidate GROUP BY candidate.id
    )
    SELECT 1 FROM candidates candidate
    JOIN season_tokens season_token ON season_token.id = candidate.id
    LEFT JOIN private.score_week_certificates certificate
      ON certificate.league_season_id = candidate.id AND certificate.week_number = candidate.week_number
    WHERE NOT candidate.is_finalized
      OR candidate.week_end >= (p_now AT TIME ZONE 'America/New_York')::date - 4
      OR certificate.input_token IS NULL
      OR certificate.input_token IS DISTINCT FROM CASE WHEN season_token.input_token IS NULL
        THEN private.score_input_token(candidate.id, candidate.week_number)
        ELSE (SELECT jsonb_object_agg(input.key, input.value) FROM jsonb_each(season_token.input_token) input
          WHERE CASE WHEN split_part(input.key, ':', 1) IN ('nba', 'lineup', 'result')
            THEN split_part(input.key, ':', 3)::int <= candidate.week_number ELSE true END)
      END
  ) THEN
    PERFORM private.work_enqueue('sync-scores',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;
