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
END;
$$;
