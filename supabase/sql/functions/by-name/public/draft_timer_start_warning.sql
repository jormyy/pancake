CREATE OR REPLACE FUNCTION public.draft_timer_start_warning(
  p_league_id uuid,
  p_rounds int DEFAULT 3,
  p_pick_timer_seconds int DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_year int;
  v_picks int;
  v_cutoff timestamptz;
  v_finish timestamptz;
BEGIN
  IF p_rounds IS NULL OR p_rounds < 1 OR p_rounds > 3 THEN
    RAISE EXCEPTION 'Rookie draft rounds must be between 1 and 3.';
  END IF;
  IF p_pick_timer_seconds IS NULL OR p_pick_timer_seconds < 60 OR p_pick_timer_seconds > 604800 THEN
    RAISE EXCEPTION 'Draft timer seconds must be between 60 and 604800.';
  END IF;
  SELECT season_year INTO v_season_year FROM league_seasons WHERE league_id = p_league_id AND is_current;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active season for this league'; END IF;
  SELECT count(*) * p_rounds INTO v_picks FROM league_members WHERE league_id = p_league_id;
  v_cutoff := private.draft_timer_opening_night_cutoff(v_season_year);
  v_finish := clock_timestamp() + make_interval(secs => v_picks::double precision * p_pick_timer_seconds);
  RETURN jsonb_build_object(
    'code', CASE WHEN v_cutoff IS NULL THEN 'opening_night_unpublished'
                 WHEN v_finish >= v_cutoff THEN 'opening_night_overrun' ELSE NULL END,
    'openingNightCutoff', v_cutoff,
    'estimatedFinishAt', v_finish,
    'remainingPicks', v_picks,
    'timerSeconds', p_pick_timer_seconds
  );
END;
$$;
