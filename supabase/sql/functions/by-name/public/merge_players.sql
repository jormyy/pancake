-- Canonical SQL source for public.merge_players.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION merge_players(winner_id uuid, loser_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_loser_sleeper_id text;
  v_loser_nba_id text;
BEGIN
  IF winner_id = loser_id THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = winner_id) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = loser_id)  THEN RETURN; END IF;

  SELECT sleeper_id, nba_id
    INTO v_loser_sleeper_id, v_loser_nba_id
    FROM players
   WHERE id = loser_id;

  UPDATE players
    SET sleeper_id = NULL
    WHERE id = loser_id AND v_loser_sleeper_id IS NOT NULL
      AND (SELECT sleeper_id FROM players WHERE id = winner_id) IS NULL;

  UPDATE players
    SET sleeper_id = v_loser_sleeper_id
    WHERE id = winner_id AND sleeper_id IS NULL
      AND v_loser_sleeper_id IS NOT NULL;

  UPDATE players
    SET nba_id = NULL
    WHERE id = loser_id AND v_loser_nba_id IS NOT NULL
      AND (SELECT nba_id FROM players WHERE id = winner_id) IS NULL;

  UPDATE players
    SET nba_id = v_loser_nba_id
    WHERE id = winner_id AND nba_id IS NULL
      AND v_loser_nba_id IS NOT NULL;

  -- roster_players: drop the loser's rows that already have a winner row in the
  -- same (league, season) before re-pointing the rest.
  DELETE FROM roster_players
    WHERE player_id = loser_id
      AND (league_id, league_season_id) IN (
        SELECT league_id, league_season_id FROM roster_players WHERE player_id = winner_id
      );
  UPDATE roster_players SET player_id = winner_id WHERE player_id = loser_id;

  -- trade_block_items: UNIQUE(league, member, player) — drop loser listings a
  -- winner listing already covers, then re-point the rest.
  DELETE FROM trade_block_items AS stale
    WHERE stale.player_id = loser_id
      AND EXISTS (
        SELECT 1 FROM trade_block_items AS kept
         WHERE kept.league_id = stale.league_id
           AND kept.member_id = stale.member_id
           AND kept.player_id = winner_id
      );
  UPDATE trade_block_items SET player_id = winner_id WHERE player_id = loser_id;

  -- weekly_lineups: same, scoped by (league, season, member, game_date).
  DELETE FROM weekly_lineups
    WHERE player_id = loser_id
      AND (league_id, league_season_id, member_id, game_date) IN (
        SELECT league_id, league_season_id, member_id, game_date
          FROM weekly_lineups WHERE player_id = winner_id
      );
  UPDATE weekly_lineups SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_projections
    WHERE player_id = loser_id
      AND (season_year, week_number) IN (
        SELECT season_year, week_number FROM player_projections WHERE player_id = winner_id
      );
  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;

  -- nominations: UNIQUE(draft_id, player_id) — drop loser dupes per draft first.
  DELETE FROM nominations
    WHERE player_id = loser_id
      AND draft_id IN (SELECT draft_id FROM nominations WHERE player_id = winner_id);
  UPDATE nominations SET player_id = winner_id WHERE player_id = loser_id;

  UPDATE waiver_claims       SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE waiver_claims       SET drop_player_id = winner_id WHERE drop_player_id = loser_id;
  UPDATE waiver_wire_log     SET player_id = winner_id WHERE player_id = loser_id;

  -- One identity cannot be rostered and clearing waivers in the same season.
  UPDATE waiver_wire_log AS log
     SET cleared_at = now()
   WHERE log.player_id = winner_id
     AND log.cleared_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM roster_players AS roster
        WHERE roster.league_id = log.league_id
          AND roster.league_season_id = log.league_season_id
          AND roster.player_id = winner_id
     );
  UPDATE trade_items         SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE roster_transactions SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE snake_draft_picks   SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_game_stats
    WHERE player_id = loser_id
      AND game_id IN (SELECT game_id FROM player_game_stats WHERE player_id = winner_id);
  UPDATE player_game_stats SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM players WHERE id = loser_id;
END;
$$;
