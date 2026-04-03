-- ── Dedup players ────────────────────────────────────────────────
-- Root cause: Sleeper returns multiple entries for the same real player
-- (e.g. first_name="Nicolas" and first_name="Nic" with different player_ids),
-- and the name-based fallback match in sync-players doesn't catch nickname
-- variations, so both get inserted as separate rows.
--
-- This migration:
--   1. Creates a reusable merge_duplicate_players() function (called by sync)
--   2. Runs a one-time cleanup: same-nba_id pairs + same-team/last_name/first_name-prefix pairs

-- ── Helper: merge two player records, keeping winner ─────────────
CREATE OR REPLACE FUNCTION merge_players(winner_id uuid, loser_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF winner_id = loser_id THEN RETURN; END IF;
  -- Skip if either record was already removed by a previous merge
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = winner_id) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = loser_id)  THEN RETURN; END IF;

  -- Free loser's unique sleeper_id slot, then give it to winner if winner lacks one
  UPDATE players
    SET sleeper_id = NULL
    WHERE id = loser_id AND sleeper_id IS NOT NULL
      AND (SELECT sleeper_id FROM players WHERE id = winner_id) IS NULL;

  UPDATE players
    SET sleeper_id = (SELECT sleeper_id FROM players WHERE id = loser_id)
    WHERE id = winner_id AND sleeper_id IS NULL
      AND (SELECT sleeper_id FROM players WHERE id = loser_id) IS NOT NULL;

  -- Reassign FK references
  UPDATE roster_players SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE weekly_lineups SET player_id = winner_id WHERE player_id = loser_id;

  -- player_projections has unique(player_id, season_year, week_number): drop conflicts first
  DELETE FROM player_projections
    WHERE player_id = loser_id
      AND (season_year, week_number) IN (
        SELECT season_year, week_number FROM player_projections WHERE player_id = winner_id
      );
  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE nominations         SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE waiver_claims       SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE waiver_claims       SET drop_player_id = winner_id WHERE drop_player_id = loser_id;
  UPDATE waiver_wire_log     SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE trade_items         SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE roster_transactions SET player_id = winner_id WHERE player_id = loser_id;

  -- Game stats: drop loser's rows for games where winner already has a row,
  -- then reassign the rest
  DELETE FROM player_game_stats
    WHERE player_id = loser_id
      AND game_id IN (SELECT game_id FROM player_game_stats WHERE player_id = winner_id);
  UPDATE player_game_stats SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM players WHERE id = loser_id;
END;
$$;

-- ── Recurring: merge by nba_id (called from sync after syncNBAIds) ─
CREATE OR REPLACE FUNCTION merge_duplicate_players()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
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
END;
$$;

GRANT EXECUTE ON FUNCTION merge_players(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION merge_duplicate_players() TO service_role;

-- ── One-time cleanup ──────────────────────────────────────────────

-- Phase 1: same nba_id
SELECT merge_duplicate_players();

-- Phase 2: same (last_name, nba_team) + one first_name is a prefix of the other
-- e.g. "Nic" / "Nicolas" both on BKN → duplicates
DO $$
DECLARE
  r RECORD;
  winner_id uuid;
  loser_id uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (LEAST(p1.id::text, p2.id::text))
      p1.id   AS id1,
      p2.id   AS id2,
      (p1.sleeper_id IS NOT NULL)::int + (p1.nba_id IS NOT NULL)::int AS score1,
      (p2.sleeper_id IS NOT NULL)::int + (p2.nba_id IS NOT NULL)::int AS score2
    FROM players p1
    JOIN players p2
      ON p1.id < p2.id
      AND lower(p1.last_name) = lower(p2.last_name)
      AND p1.nba_team IS NOT NULL
      AND p1.nba_team = p2.nba_team
      AND (
        lower(p2.first_name) LIKE lower(p1.first_name) || '%'
        OR lower(p1.first_name) LIKE lower(p2.first_name) || '%'
      )
  LOOP
    IF r.score1 >= r.score2 THEN
      winner_id := r.id1; loser_id := r.id2;
    ELSE
      winner_id := r.id2; loser_id := r.id1;
    END IF;
    PERFORM merge_players(winner_id, loser_id);
  END LOOP;
END $$;
