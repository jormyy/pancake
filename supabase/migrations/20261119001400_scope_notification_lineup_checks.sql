SET lock_timeout='3s';
SET statement_timeout='30s';
CREATE OR REPLACE FUNCTION private.notif_lineup_candidates_scoped(p_now timestamptz,p_league_id uuid,p_member_id uuid)
RETURNS TABLE(event_type text,league_id uuid,member_id uuid,player_id uuid,game_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH day AS (SELECT (p_now AT TIME ZONE 'America/New_York')::date AS date),
  members AS (
    SELECT m.id,m.league_id,s.id AS season_id,day.date FROM public.league_members m
    JOIN public.leagues l ON l.id=m.league_id AND l.deleted_at IS NULL AND l.status IN ('active','playoffs')
    JOIN public.league_seasons s ON s.league_id=l.id AND s.is_current CROSS JOIN day
    WHERE (p_league_id IS NULL OR m.league_id=p_league_id)
      AND (p_member_id IS NULL OR m.id=p_member_id)
      AND EXISTS(SELECT 1 FROM public.nba_games g WHERE g.game_date=day.date AND g.season_year=s.season_year
      AND private.lineup_game_available(g.status,g.game_status_text) AND g.game_time<=p_now+interval '2 hours')
      AND EXISTS(SELECT 1 FROM public.nba_games g WHERE g.game_date=day.date AND g.season_year=s.season_year
      AND private.lineup_game_available(g.status,g.game_status_text) AND g.status='Scheduled' AND g.game_time>p_now
      AND (g.started_at IS NULL OR g.started_at>p_now))
  )
  SELECT 'lineup_inactive'::text,m.league_id,m.id,p.id,m.date FROM members m
  JOIN public.weekly_lineups w ON w.member_id=m.id AND w.league_id=m.league_id AND w.league_season_id=m.season_id AND w.game_date=m.date
  JOIN public.roster_players r ON r.member_id=m.id AND r.league_id=m.league_id AND r.league_season_id=m.season_id AND r.player_id=w.player_id
  JOIN public.players p ON p.id=w.player_id
  WHERE w.slot_type NOT IN ('BE','IR') AND NOT r.is_on_ir AND NOT r.is_on_taxi
    AND NOT private.lineup_game_started(p.id,m.date) AND NOT private.roster_status_game_started(p.id)
    AND (lower(COALESCE(p.injury_status,'')) IN ('out','inactive','suspended')
      OR lower(COALESCE(p.status,'')) IN ('out','inactive','suspended')
      OR NOT EXISTS(SELECT 1 FROM private.notif_player_games(p.id,m.date) g WHERE private.lineup_game_available(g.status,g.game_status_text)))
  UNION
  SELECT 'lineup_empty'::text,m.league_id,m.id,NULL::uuid,m.date FROM members m
  WHERE EXISTS(
    SELECT 1 FROM public.lineup_slot_templates slot WHERE slot.league_id=m.league_id AND slot.slot_type NOT IN ('BE','IR')
      AND slot.slot_count>(SELECT count(*) FROM public.weekly_lineups w WHERE w.member_id=m.id AND w.league_id=m.league_id
        AND w.league_season_id=m.season_id AND w.game_date=m.date AND w.slot_type=slot.slot_type)
      AND EXISTS(
        SELECT 1 FROM public.roster_players r JOIN public.players p ON p.id=r.player_id
        WHERE r.member_id=m.id AND r.league_id=m.league_id AND r.league_season_id=m.season_id AND NOT r.is_on_ir AND NOT r.is_on_taxi
          AND (CASE WHEN cardinality(p.eligible_positions)>0 THEN p.eligible_positions
            ELSE ARRAY[p.position::text] END
            && public.lineup_slot_allowed_positions(slot.slot_type))
          AND NOT private.lineup_game_started(p.id,m.date) AND NOT private.roster_status_game_started(p.id)
          AND EXISTS(SELECT 1 FROM private.notif_player_games(p.id,m.date) g WHERE private.lineup_game_available(g.status,g.game_status_text)
            AND g.status='Scheduled' AND g.game_time>p_now AND (g.started_at IS NULL OR g.started_at>p_now))
      )
  );
$$;
CREATE OR REPLACE FUNCTION private.notif_lineup_candidates(p_now timestamptz DEFAULT now())
RETURNS TABLE(event_type text,league_id uuid,member_id uuid,player_id uuid,game_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT event_type,league_id,member_id,player_id,game_date
  FROM private.notif_lineup_candidates_scoped(p_now,NULL,NULL);
$$;
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

ALTER FUNCTION private.notif_lineup_candidates_scoped(timestamptz,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.notif_lineup_candidates_scoped(timestamptz,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
