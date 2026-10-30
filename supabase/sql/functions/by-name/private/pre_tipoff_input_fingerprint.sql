-- Canonical SQL source for private.pre_tipoff_input_fingerprint.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.pre_tipoff_input_fingerprint(p_game_date date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH teams AS MATERIALIZED (
    SELECT s.league_id, s.league_season_id, s.member_id, ls.season_year, l.scoring_settings
    FROM public.lineup_optimizer_settings s
    JOIN public.league_seasons ls ON ls.id = s.league_season_id AND ls.is_current
    JOIN public.leagues l ON l.id = s.league_id AND l.status IN ('active', 'playoffs')
    WHERE s.enabled AND EXISTS (
      SELECT 1 FROM public.nba_games g WHERE g.game_date = p_game_date AND g.season_year = ls.season_year
    )
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id IN (SELECT league_id FROM teams)),
    'games', (SELECT jsonb_agg(jsonb_build_array(g.id, g.game_date, g.game_time, g.home_team,
        g.away_team, private.lineup_game_available(g.status, g.game_status_text)) ORDER BY g.id)
      FROM public.nba_games g WHERE g.game_date = p_game_date),
    'projections', (SELECT jsonb_agg(jsonb_build_array(t.league_id,
        to_jsonb(p)-'projection_fetched_at') ORDER BY t.league_id,p.player_id)
      FROM (SELECT DISTINCT league_id,season_year FROM teams) t CROSS JOIN LATERAL public.get_league_projection_rows(t.league_id,t.season_year,
        p_game_date,'today',ARRAY(SELECT DISTINCT r.player_id FROM roster r
          WHERE r.league_id=t.league_id),1000,0) p)
  )::text);
$$;
