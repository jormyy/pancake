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

  UPDATE roster_players SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE weekly_lineups SET player_id = winner_id WHERE player_id = loser_id;

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
  UPDATE trade_drop_reservations SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE roster_transactions SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE snake_draft_picks   SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_game_stats
    WHERE player_id = loser_id
      AND game_id IN (SELECT game_id FROM player_game_stats WHERE player_id = winner_id);
  UPDATE player_game_stats SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM players WHERE id = loser_id;
END;
$$;

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
