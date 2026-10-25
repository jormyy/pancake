SELECT private.player_identity_name(display_name) AS name_key,
  private.player_identity_team(nba_team) AS team,
  (array_agg(id ORDER BY (nba_id IS NOT NULL) DESC,created_at,id))[1] AS survivor,
  (array_agg(id ORDER BY (nba_id IS NOT NULL) DESC,created_at,id))[2:] AS merged_rows,
  array_agg(display_name ORDER BY id) AS names
FROM public.players
WHERE nullif(private.player_identity_team(nba_team),'') IS NOT NULL
GROUP BY private.player_identity_name(display_name),private.player_identity_team(nba_team)
HAVING count(*)>1 AND count(DISTINCT nba_id)<=1 AND count(DISTINCT sleeper_id)<=1
  AND count(DISTINCT espn_id)<=1 AND count(DISTINCT sportsdata_id)<=1
ORDER BY name_key,team;

SELECT g.season_year,left(g.nba_game_id,3) AS game_id_prefix,
  min(g.game_date) AS first_date,max(g.game_date) AS last_date,
  count(DISTINCT g.id) AS games,count(*) AS stat_rows,
  count(*) FILTER(WHERE s.minutes_played>0 AND NOT s.did_not_play) AS played_rows,
  bool_and(public.is_regular_season_game_id(g.nba_game_id)) AS regular_season
FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
GROUP BY g.season_year,left(g.nba_game_id,3)
ORDER BY g.season_year,game_id_prefix;

SELECT p.id,p.display_name,p.nba_team,p.years_exp,p.career_regular_season_games,
  p.career_games_base,p.career_games_base_season,p.career_games_base_source,
  p.career_games_base_checked_at,p.career_games_base_attempted_at,
  CASE WHEN p.career_regular_season_games>=65 THEN 'Taxi threshold established; no lookup'
    WHEN p.career_games_base_source='coverage' THEN 'Provisional coverage below 65; ESPN base due'
    WHEN p.career_games_base IS NOT NULL THEN 'Established base; no lookup'
    WHEN p.career_regular_season_games IS NOT NULL THEN 'Preserved legacy count; ESPN base due'
    WHEN f.source IS NOT NULL THEN 'Available fallback: '||f.source
    ELSE 'Unknown; ESPN base required' END AS state
FROM public.players p
CROSS JOIN LATERAL private.player_career_fallback(p.id,p.years_exp,public.current_season_year_et()) f
ORDER BY p.display_name,p.id;

SELECT count(*) AS nba_team_queue,
  count(*) FILTER(WHERE career_regular_season_games IS NULL) AS unknown,
  count(*) FILTER(WHERE career_regular_season_games<65 AND career_games_base IS NULL) AS known_below_65,
  count(*) FILTER(WHERE career_regular_season_games<65 AND career_games_base_source='coverage') AS coverage_below_65,
  count(*) FILTER(WHERE career_games_base_attempted_at IS NULL OR career_games_base_attempted_at<=now()-interval '7 days') AS due_now
FROM public.players
WHERE nullif(nba_team,'') IS NOT NULL
  AND (career_regular_season_games IS NULL OR career_regular_season_games<65)
  AND (career_games_base IS NULL OR career_games_base_source='coverage');

SELECT p.id,p.display_name,p.nba_team,p.espn_id,p.nba_id,p.sleeper_id,p.years_exp,p.position,
  array_remove(ARRAY[
    CASE WHEN p.espn_id IS NULL THEN 'espn_id' END,
    CASE WHEN p.nba_id IS NULL THEN 'nba_id' END,
    CASE WHEN p.sleeper_id IS NULL THEN 'sleeper_id' END,
    CASE WHEN p.years_exp IS NULL THEN 'years_exp' END,
    CASE WHEN p.position IS NULL THEN 'position' END
  ],NULL) AS missing_fields,
  ARRAY(SELECT r.source FROM private.player_roster_presence r WHERE r.provider_id=CASE r.source WHEN 'espn' THEN p.espn_id ELSE p.nba_id END ORDER BY r.source) AS roster_sources
FROM public.players p
WHERE (EXISTS(SELECT FROM private.player_roster_presence r WHERE r.provider_id=CASE r.source WHEN 'espn' THEN p.espn_id ELSE p.nba_id END)
    OR p.nba_team IS NOT NULL)
  AND (p.espn_id IS NULL OR p.nba_id IS NULL OR p.sleeper_id IS NULL OR p.years_exp IS NULL OR p.position IS NULL)
ORDER BY p.display_name,p.id;

SELECT p.id,p.display_name,p.nba_team,a.first_absent_at,a.last_absent_at
FROM private.player_roster_absences a JOIN public.players p ON p.id=a.player_id
WHERE p.nba_team IS NOT NULL ORDER BY a.first_absent_at,p.display_name;
