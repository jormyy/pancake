CREATE OR REPLACE FUNCTION private.retain_matchup_forecast_queue(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '100ms'
AS $$
DECLARE v_count bigint;
BEGIN
  WITH victims AS (
    SELECT r.matchup_id FROM private.matchup_forecast_queue r
    WHERE (r.claimed_at IS NULL OR r.claimed_at<p_now-interval '3 minutes') AND EXISTS (SELECT 1 FROM public.matchups m
        JOIN public.league_seasons s ON s.id=m.league_season_id
        JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=COALESCE(m.end_week_number,m.week_number)
        WHERE m.id=r.matchup_id AND (m.is_voided OR w.week_end<(p_now AT TIME ZONE 'America/New_York')::date-7))
    ORDER BY r.changed_at,r.matchup_id LIMIT 5000 FOR UPDATE OF r SKIP LOCKED
  ) DELETE FROM private.matchup_forecast_queue r USING victims v WHERE r.matchup_id=v.matchup_id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('private.matchup_forecast_queue',v_count);
END;
$$;
