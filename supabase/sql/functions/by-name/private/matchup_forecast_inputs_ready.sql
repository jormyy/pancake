CREATE OR REPLACE FUNCTION private.matchup_forecast_inputs_ready(p_matchup_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
WITH context AS MATERIALIZED (
  SELECT m.id,m.league_id,m.league_season_id,m.home_member_id,m.away_member_id,s.season_year,
    w.week_start,e.week_end,md5(l.scoring_settings::text) AS scoring_hash,
    (now() AT TIME ZONE 'America/New_York')::date AS today,
    (SELECT revision FROM private.forecast_input_revisions WHERE kind='history') AS history_revision,
    (SELECT revision FROM private.forecast_input_revisions WHERE kind='projection') AS projection_revision
  FROM public.matchups m JOIN public.league_seasons s ON s.id=m.league_season_id
  JOIN public.leagues l ON l.id=m.league_id
  JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
  JOIN public.season_weeks e ON e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
  WHERE m.id=p_matchup_id AND NOT m.is_voided
), players AS MATERIALIZED (
  SELECT r.player_id FROM context c JOIN public.roster_players r
    ON r.league_id=c.league_id AND r.league_season_id=c.league_season_id
    AND r.member_id IN(c.home_member_id,c.away_member_id)
), roster AS (
  SELECT md5(COALESCE(string_agg(player_id::text,',' ORDER BY player_id),'')) AS fingerprint FROM players
)
SELECT EXISTS(SELECT 1 FROM context) AND NOT EXISTS (
  SELECT 1 FROM context c CROSS JOIN players r LEFT JOIN private.forecast_player_history h
    ON h.league_id=c.league_id AND h.season_year=c.season_year AND h.player_id=r.player_id
  WHERE h.player_id IS NULL OR h.observed_date<>c.today OR h.revision<>c.history_revision OR h.scoring_hash<>c.scoring_hash
) AND NOT EXISTS (
  SELECT 1 FROM context c CROSS JOIN players r JOIN analytics.player_season_totals t
    ON t.player_id=r.player_id AND t.season_year=c.season_year
  LEFT JOIN private.forecast_season_points p ON p.league_id=c.league_id AND p.season_year=c.season_year AND p.player_id=r.player_id
  WHERE p.player_id IS NULL OR p.scoring_hash<>c.scoring_hash OR p.source_revision<>t.xmin::text
) AND NOT EXISTS (
  SELECT 1 FROM context c CROSS JOIN roster r JOIN public.nba_games g ON g.season_year=c.season_year
    AND g.game_date BETWEEN GREATEST(c.week_start,c.today) AND c.week_end
  LEFT JOIN private.forecast_projection_inputs p ON p.matchup_id=c.id AND p.game_date=g.game_date
  WHERE public.is_regular_season_game_id(g.nba_game_id) AND g.status NOT IN('Final','Postponed','Cancelled')
    AND (p.matchup_id IS NULL OR p.observed_date<>c.today OR p.revision<>c.projection_revision
      OR p.scoring_hash<>c.scoring_hash OR p.roster_hash<>r.fingerprint OR p.valid_until<=now())
);
$$;
