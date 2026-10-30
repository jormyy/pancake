BEGIN;

CREATE OR REPLACE FUNCTION private.roster_status_game_started(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH slate AS (
    SELECT (now() AT TIME ZONE 'America/New_York')::date AS today
  ), recent_games AS MATERIALIZED (
    SELECT game.id, game.game_date, game.home_team, game.away_team,
      game.status, game.game_time, game.started_at
    FROM nba_games game CROSS JOIN slate
    WHERE game.game_date IN (slate.today - 1, slate.today)
  ), participation AS (
    SELECT game.id AS game_id
    FROM recent_games game
    WHERE EXISTS (
      SELECT 1 FROM player_game_stats stats
      WHERE stats.player_id = p_player_id AND stats.game_id = game.id
    ) OR EXISTS (
      SELECT 1 FROM private.player_game_memberships membership
      WHERE membership.player_id = p_player_id AND membership.game_id = game.id
    )
  )
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN recent_games AS g ON (
        ((g.home_team = p.nba_team OR g.away_team = p.nba_team)
          AND NOT EXISTS (
            SELECT 1 FROM participation AS observed
            JOIN recent_games AS actual ON actual.id = observed.game_id
            WHERE actual.game_date = g.game_date
          ))
        OR EXISTS (
          SELECT 1 FROM participation AS stats
          WHERE stats.game_id = g.id
        )
      )
      CROSS JOIN slate
     WHERE p.id = p_player_id
       AND g.game_date IN (slate.today - 1, slate.today)
       AND (
         g.status = 'InProgress'
         OR (g.game_date = slate.today AND g.status = 'Final')
         OR (g.game_time <= now() AND (g.game_date = slate.today OR g.game_time >= now() - interval '12 hours'))
         OR (g.started_at <= now() AND (g.game_date = slate.today OR g.started_at >= now() - interval '12 hours'))
       )
  )
$$;

COMMIT;
