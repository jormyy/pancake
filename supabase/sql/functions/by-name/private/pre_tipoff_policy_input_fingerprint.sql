-- Canonical SQL source for private.pre_tipoff_policy_input_fingerprint.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.pre_tipoff_policy_input_fingerprint(p_game_date date, p_league_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH league AS MATERIALIZED (
    SELECT l.id AS league_id, ls.id AS league_season_id, ls.season_year,
      l.scoring_settings, l.roster_size, l.ir_slots
    FROM public.leagues l
    JOIN public.league_seasons ls ON ls.league_id = l.id AND ls.is_current
    WHERE l.id = p_league_id AND l.status IN ('active', 'playoffs')
      AND private.league_auto_ir_all_members(l.id)
  ), teams AS MATERIALIZED (
    SELECT member.league_id, league.league_season_id, member.id AS member_id,
      league.season_year, league.scoring_settings, league.roster_size, league.ir_slots,
      COALESCE(setting.enabled, false) AS optimizer_enabled
    FROM public.league_members member
    JOIN league ON league.league_id = member.league_id
    LEFT JOIN public.lineup_optimizer_settings setting
      ON setting.league_id = member.league_id AND setting.league_season_id = league.league_season_id
     AND setting.member_id = member.id
  ), roster AS MATERIALIZED (
    SELECT rp.league_id, rp.member_id, p.id AS player_id, p.nba_team, p.position,
      p.eligible_positions, p.injury_status, p.injury_expected_return,
      p.career_regular_season_games, rp.is_on_ir, rp.is_on_taxi
    FROM teams t JOIN public.roster_players rp ON rp.league_id = t.league_id
      AND rp.league_season_id = t.league_season_id AND rp.member_id = t.member_id
    JOIN public.players p ON p.id = rp.player_id
  )
  SELECT md5(jsonb_build_object(
    'teams', (SELECT jsonb_agg(to_jsonb(t) ORDER BY league_id, member_id) FROM teams t),
    'roster', (SELECT jsonb_agg(to_jsonb(r) ORDER BY league_id, member_id, player_id) FROM roster r),
    'locks', (SELECT jsonb_agg(jsonb_build_array(t.league_id, t.member_id, la.asset_kind, la.asset_id,
        la.source_kind, la.source_id) ORDER BY t.league_id, t.member_id, la.asset_kind, la.asset_id)
      FROM teams t CROSS JOIN LATERAL private.locked_assets(t.league_id, t.league_season_id, t.member_id) la),
    'pins', (SELECT jsonb_agg(to_jsonb(pin) ORDER BY pin.league_id, pin.member_id, pin.player_id)
      FROM public.lineup_player_pins pin JOIN teams t ON t.league_id = pin.league_id
        AND t.league_season_id = pin.league_season_id AND t.member_id = pin.member_id
      WHERE pin.game_date = p_game_date),
    'slots', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.league_id, s.slot_type)
      FROM public.lineup_slot_templates s WHERE s.league_id = p_league_id),
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
