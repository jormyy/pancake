-- Canonical SQL source for private.read_matchup_forecast_context.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.read_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.id,m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,m.home_points,m.away_points,m.is_finalized,
    s.season_year,w.week_start,e.week_end,now() AS observed_at,
    (now() AT TIME ZONE 'America/New_York')::date AS today
  FROM public.matchups m
  JOIN public.leagues l ON l.id=m.league_id
  JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
  JOIN public.season_weeks e ON e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
  WHERE m.id=p_matchup_id AND NOT m.is_voided
), roster AS MATERIALIZED (
  SELECT r.member_id,r.player_id,r.is_on_ir,r.is_on_taxi,p.nba_team,p.eligible_positions,p.injury_status
  FROM context c JOIN public.roster_players r ON r.league_id=c.league_id AND r.league_season_id=c.league_season_id
    AND r.member_id IN(c.home_member_id,c.away_member_id)
  JOIN public.players p ON p.id=r.player_id
), games AS MATERIALIZED (
  SELECT g.id,g.game_date,g.home_team,g.away_team,g.status,g.game_time,g.started_at,
    g.live_scoreboard_elapsed_seconds,g.live_stats_elapsed_seconds
  FROM context c JOIN public.nba_games g ON g.season_year=c.season_year
    AND g.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
  WHERE public.is_regular_season_game_id(g.nba_game_id)
), history AS (
  SELECT h.player_id,h.scores FROM context c CROSS JOIN roster r
  JOIN private.forecast_player_history h ON h.league_id=c.league_id AND h.season_year=c.season_year AND h.player_id=r.player_id
  WHERE cardinality(h.scores)>0
), projections AS (
  SELECT p.game_date,item.ordinality,
    CASE WHEN item.value->>'projection_source_label'='Season Avg'
      THEN jsonb_set(item.value,'{projection_fantasy_points}',COALESCE(to_jsonb(a.fantasy_points),'null'::jsonb))
      ELSE item.value END AS projection
  FROM context c JOIN private.forecast_projection_inputs p ON p.matchup_id=c.id
  CROSS JOIN LATERAL jsonb_array_elements(p.rows) WITH ORDINALITY item(value,ordinality)
  LEFT JOIN private.forecast_season_points a ON a.league_id=c.league_id AND a.season_year=c.season_year
    AND a.player_id=(item.value->>'player_id')::uuid
  WHERE p.game_date IN (SELECT DISTINCT game_date FROM games WHERE status NOT IN('Final','Postponed','Cancelled'))
)
SELECT jsonb_build_object(
  'matchupId',c.id,'observedAt',c.observed_at,'today',c.today,'weekEnd',c.week_end,'isFinalized',c.is_finalized,
  'teams',jsonb_build_array(jsonb_build_object('memberId',c.home_member_id,'currentPoints',COALESCE(c.home_points,0)),
    jsonb_build_object('memberId',c.away_member_id,'currentPoints',COALESCE(c.away_points,0))),
  'roster',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.player_id) FROM roster r),'[]'::jsonb),
  'games',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.game_date,g.id) FROM games g),'[]'::jsonb),
  'history',COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.player_id) FROM history h),'[]'::jsonb),
  'projections',COALESCE((SELECT jsonb_agg(p.projection ORDER BY p.game_date,p.ordinality) FROM projections p),'[]'::jsonb),
  'lineups',COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id',l.member_id,'player_id',l.player_id,
    'game_date',l.game_date,'slot_type',l.slot_type,'is_auto_set',l.is_auto_set) ORDER BY l.game_date,l.member_id,l.player_id)
    FROM public.weekly_lineups l WHERE l.league_season_id=c.league_season_id
      AND l.member_id IN(c.home_member_id,c.away_member_id) AND l.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end),'[]'::jsonb),
  'templates',COALESCE((SELECT jsonb_agg(jsonb_build_object('slot_type',t.slot_type,'slot_count',t.slot_count) ORDER BY t.slot_type)
    FROM public.lineup_slot_templates t WHERE t.league_id=c.league_id AND t.slot_type NOT IN('BE','IR')),'[]'::jsonb),
  'automaticMembers',COALESCE((SELECT jsonb_agg(s.member_id ORDER BY s.member_id)
    FROM public.lineup_optimizer_settings s WHERE s.league_season_id=c.league_season_id
      AND s.member_id IN(c.home_member_id,c.away_member_id) AND s.enabled),'[]'::jsonb),
  'previous',COALESCE((SELECT f.forecast FROM public.matchup_forecasts f WHERE f.matchup_id=c.id),'null'::jsonb)
) FROM context c;
$$;
