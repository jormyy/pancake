CREATE OR REPLACE FUNCTION private.enqueue_screen_views(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id)
  SELECT season.league_id, season.id FROM public.league_seasons season
  JOIN public.leagues league ON league.id = season.league_id AND league.deleted_at IS NULL
  ORDER BY season.id ON CONFLICT DO NOTHING;
  UPDATE private.screen_refresh_queue queued SET version = version + 1, dirty = true, available_at = p_now, changed_at = p_now
  WHERE NOT queued.dirty AND EXISTS (
    SELECT 1 FROM public.trade_value_cache cached WHERE cached.league_season_id = queued.league_season_id AND cached.valid_until <= p_now);
  IF EXISTS (SELECT 1 FROM private.screen_refresh_queue WHERE dirty AND available_at <= p_now
    AND (claimed_at IS NULL OR claimed_at < p_now - interval '3 minutes')) THEN
    PERFORM private.work_enqueue('refresh-views',date_trunc('minute',p_now)::text,p_now);
  END IF;
END;
$$;
