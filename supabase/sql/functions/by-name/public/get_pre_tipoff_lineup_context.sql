-- Canonical SQL source for public.get_pre_tipoff_lineup_context.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_pre_tipoff_lineup_context(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'date', (now() AT TIME ZONE 'America/New_York')::date,
    'seasonYear', ls.season_year,
    'weekNumber', sw.week_number,
    'players', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'playerId', p.id, 'eligiblePositions', CASE WHEN cardinality(p.eligible_positions) > 0
          THEN p.eligible_positions ELSE ARRAY[p.position::text] END,
        'injuryStatus', p.injury_status,
        'locked', private.lineup_game_started(p.id, sw_date.game_date),
        'hasGame', EXISTS (SELECT 1 FROM public.nba_games g
          WHERE g.game_date = sw_date.game_date AND private.lineup_game_available(g.status, g.game_status_text)
            AND (g.home_team = p.nba_team OR g.away_team = p.nba_team))
      ) ORDER BY p.id)
      FROM public.roster_players rp JOIN public.players p ON p.id = rp.player_id
      WHERE rp.league_id = p_league_id AND rp.league_season_id = p_league_season_id
        AND rp.member_id = p_member_id AND NOT rp.is_on_ir AND NOT rp.is_on_taxi
    ), '[]'::jsonb),
    'templates', COALESCE((SELECT jsonb_agg(jsonb_build_object('slotType', slot_type, 'count', slot_count) ORDER BY slot_type)
      FROM public.lineup_slot_templates WHERE league_id = p_league_id
        AND slot_type NOT IN ('BE', 'IR')), '[]'::jsonb),
    'stored', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'player_id', wl.player_id, 'slot_type', wl.slot_type,
      'is_auto_set', wl.is_auto_set, 'week_number', wl.week_number,
      'locked', private.lineup_game_started(wl.player_id, wl.game_date)
    ) ORDER BY wl.player_id) FROM public.weekly_lineups wl
      WHERE wl.league_id = p_league_id AND wl.league_season_id = p_league_season_id
        AND wl.member_id = p_member_id AND wl.game_date = sw_date.game_date), '[]'::jsonb)
  )
  FROM public.lineup_optimizer_settings s
  JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
  JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
  CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE 'America/New_York')::date AS game_date) sw_date
  LEFT JOIN public.season_weeks sw ON sw.season_year = ls.season_year
    AND sw_date.game_date BETWEEN sw.week_start AND sw.week_end
  WHERE s.league_id = p_league_id AND s.league_season_id = p_league_season_id
    AND s.member_id = p_member_id AND s.enabled;
$$;
