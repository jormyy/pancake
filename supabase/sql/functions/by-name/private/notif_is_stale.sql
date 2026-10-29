CREATE OR REPLACE FUNCTION private.notif_is_stale(p_event text, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  deadline timestamptz;
BEGIN
  IF p_event IN ('lineup_inactive','lineup_empty') THEN
    IF NOT coalesce(pg_input_is_valid(p_data->>'leagueId','uuid'),false)
      OR NOT coalesce(pg_input_is_valid(p_data->>'memberId','uuid'),false) THEN RETURN true; END IF;
    RETURN NOT EXISTS(SELECT 1 FROM private.notif_lineup_candidates_scoped(clock_timestamp(),(p_data->>'leagueId')::uuid,(p_data->>'memberId')::uuid) c
      WHERE c.event_type=p_event AND c.league_id::text=p_data->>'leagueId'
        AND c.member_id::text=p_data->>'memberId' AND c.game_date::text=p_data->>'gameDate'
        AND (p_event='lineup_empty' OR c.player_id::text=p_data->>'playerId'));
  END IF;
  IF p_event='matchup_close' THEN
    RETURN NOT EXISTS(SELECT 1 FROM public.matchups m
      JOIN public.league_seasons s ON s.id=m.league_season_id AND s.is_current
      JOIN public.season_weeks ending ON ending.season_year=s.season_year AND ending.week_number=COALESCE(m.end_week_number,m.week_number)
      WHERE m.id::text=p_data->>'matchupId' AND NOT m.is_finalized AND NOT m.is_voided AND m.winner_member_id IS NULL
        AND NOT m.week_number=ANY(s.skipped_weeks)
        AND (clock_timestamp() AT TIME ZONE 'America/New_York')::date=ending.week_end
        AND m.home_points IS NOT NULL AND m.away_points IS NOT NULL
        AND abs(m.home_points-m.away_points)<=greatest(10,(m.home_points+m.away_points)*0.025));
  END IF;
  IF p_event NOT IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') THEN RETURN false; END IF;
  IF p_data ? 'draftId' AND p_data ? 'nominationOrder' THEN
    SELECT * INTO d FROM public.drafts WHERE id::text = p_data->>'draftId';
    IF d.id IS NULL OR d.is_mock OR d.draft_type <> 'auction' OR d.status NOT IN ('in_progress','paused')
      OR p_event = 'draft_timer_expiring'
      OR (SELECT count(*) FROM public.draft_audit_logs WHERE draft_id = d.id AND action = 'reset')::text IS DISTINCT FROM p_data->>'resets'
      THEN RETURN true; END IF;
    IF p_event = 'draft_coming_soon' THEN
      RETURN (d.current_nomination_order + 1)::text IS DISTINCT FROM p_data->>'nominationOrder';
    END IF;
    RETURN d.current_nomination_order::text IS DISTINCT FROM p_data->>'nominationOrder'
      OR EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = d.id AND status = 'open');
  END IF;
  IF NOT (p_data ? 'draftId' AND p_data ? 'pickId') THEN RETURN true; END IF;
  SELECT * INTO d FROM public.drafts WHERE id::text = p_data->>'draftId';
  IF d.id IS NULL OR d.is_mock OR d.status NOT IN ('in_progress','paused') THEN RETURN true; END IF;
  SELECT * INTO p FROM public.snake_draft_picks WHERE id::text = p_data->>'pickId' AND draft_id = d.id;
  IF p.id IS NULL OR p.picked_at IS NOT NULL OR p.skipped_at IS NOT NULL THEN RETURN true; END IF;
  IF d.status = 'paused' THEN RETURN false; END IF;
  SELECT timer_expires_at INTO deadline FROM public.snake_draft_picks
    WHERE draft_id = d.id AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
  RETURN deadline IS NULL OR deadline <= clock_timestamp();
END;
$$;
