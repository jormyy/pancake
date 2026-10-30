-- Canonical SQL source for private.notif_lineup_candidates_scoped.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
