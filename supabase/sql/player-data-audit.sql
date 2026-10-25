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

SELECT p.id,p.display_name,p.nba_team,p.years_exp,p.career_games_prior,p.career_games_prior_checked_at,
  CASE WHEN p.years_exp IS NULL THEN 'Unknown experience and unverified pre-2020-21 prior'
    ELSE 'Possible pre-2020-21 career, fewer than 65 observed games, unverified prior' END AS reason
FROM public.players p CROSS JOIN LATERAL private.player_career_values(p.id,p.years_exp,p.career_games_prior) c
WHERE c.games IS NULL
ORDER BY p.display_name,p.id;
