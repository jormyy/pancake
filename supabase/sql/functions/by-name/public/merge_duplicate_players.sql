-- Canonical SQL source for public.merge_duplicate_players.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION merge_duplicate_players()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(1347174745, 1);
  FOR r IN
    SELECT
      (array_agg(id ORDER BY (sleeper_id IS NOT NULL) DESC, created_at ASC))[1] AS winner_id,
      unnest((array_agg(id ORDER BY (sleeper_id IS NOT NULL) DESC, created_at ASC))[2:]) AS loser_id
    FROM players
    WHERE nba_id IS NOT NULL
    GROUP BY nba_id
    HAVING count(*) > 1
  LOOP
    PERFORM merge_players(r.winner_id, r.loser_id);
  END LOOP;

  FOR r IN
    SELECT
      (array_agg(id ORDER BY (nba_id IS NOT NULL) DESC, created_at ASC))[1] AS winner_id,
      unnest((array_agg(id ORDER BY (nba_id IS NOT NULL) DESC, created_at ASC))[2:]) AS loser_id
    FROM players
    WHERE sleeper_id IS NOT NULL
    GROUP BY sleeper_id
    HAVING count(*) > 1
  LOOP
    PERFORM merge_players(r.winner_id, r.loser_id);
  END LOOP;
  FOR r IN
    SELECT ids[1] AS winner_id, unnest(ids[2:]) AS loser_id FROM (
      SELECT array_agg(id ORDER BY (nba_id IS NOT NULL) DESC, created_at, id) AS ids
      FROM players
      WHERE nullif(private.player_identity_team(nba_team), '') IS NOT NULL
        AND private.player_identity_name(display_name) <> ''
      GROUP BY private.player_identity_name(display_name), private.player_identity_team(nba_team)
      HAVING count(*) > 1
        AND count(DISTINCT nba_id) <= 1 AND count(DISTINCT sleeper_id) <= 1
        AND count(DISTINCT espn_id) <= 1 AND count(DISTINCT sportsdata_id) <= 1
        AND count(nba_id) + count(sleeper_id) + count(espn_id) + count(sportsdata_id) > 0
    ) AS compatible
  LOOP
    PERFORM merge_players(r.winner_id, r.loser_id);
  END LOOP;
END;
$$;
