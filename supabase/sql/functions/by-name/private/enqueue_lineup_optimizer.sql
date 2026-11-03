-- Canonical SQL source for private.enqueue_lineup_optimizer.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_lineup_optimizer(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_today date := (p_now AT TIME ZONE 'America/New_York')::date;
  v_midnight timestamptz := v_today::timestamp AT TIME ZONE 'America/New_York';
  v_due timestamptz;
BEGIN
  SELECT greatest(v_midnight, least((v_today + time '06:00') AT TIME ZONE 'America/New_York',
    min(g.game_time) - interval '10 minutes')) INTO v_due
  FROM public.nba_games g
  WHERE g.game_date = v_today AND g.status = 'Scheduled'
    AND private.lineup_game_available(g.status, g.game_status_text);
  IF p_now < v_due THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM public.nba_games g
    WHERE g.game_date = v_today AND g.status = 'Scheduled'
      AND private.lineup_game_available(g.status, g.game_status_text)
      AND (g.game_time IS NULL OR g.game_time > p_now)
      AND (g.started_at IS NULL OR g.started_at > p_now)
      AND EXISTS (
        SELECT 1 FROM public.lineup_optimizer_settings s
        JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
        JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
        WHERE s.enabled AND ls.season_year = g.season_year
          AND s.last_daily_optimized_date IS DISTINCT FROM v_today
      )
  ) THEN
    PERFORM private.work_enqueue('lineup-optimizer', v_today::text, p_now,
      jsonb_build_object('mode', 'daily', 'date', v_today));
  END IF;
END;
$$;
