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
  v_winner players%ROWTYPE;
  v_loser players%ROWTYPE;
BEGIN
  IF winner_id = loser_id THEN RETURN; END IF;
  PERFORM id FROM players WHERE id IN (winner_id, loser_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_winner FROM players WHERE id = winner_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_loser FROM players WHERE id = loser_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Release unique provider links before moving them to the surviving identity.
  UPDATE players SET
    sleeper_id = CASE WHEN v_winner.sleeper_id IS NULL THEN NULL ELSE sleeper_id END,
    nba_id = CASE WHEN v_winner.nba_id IS NULL THEN NULL ELSE nba_id END,
    espn_id = CASE WHEN v_winner.espn_id IS NULL THEN NULL ELSE espn_id END,
    sportsdata_id = CASE WHEN v_winner.sportsdata_id IS NULL THEN NULL ELSE sportsdata_id END
  WHERE id = loser_id;

  UPDATE players SET
    sleeper_id = COALESCE(v_winner.sleeper_id, v_loser.sleeper_id),
    nba_id = COALESCE(v_winner.nba_id, v_loser.nba_id),
    espn_id = COALESCE(v_winner.espn_id, v_loser.espn_id),
    sportsdata_id = COALESCE(v_winner.sportsdata_id, v_loser.sportsdata_id),
    nba_team = COALESCE(v_winner.nba_team, v_loser.nba_team),
    position = COALESCE(v_winner.position, v_loser.position),
    eligible_positions = CASE WHEN cardinality(v_winner.eligible_positions) = 0
      THEN v_loser.eligible_positions ELSE v_winner.eligible_positions END,
    headshot_url = COALESCE(v_winner.headshot_url, v_loser.headshot_url),
    jersey_number = COALESCE(v_winner.jersey_number, v_loser.jersey_number),
    years_exp = COALESCE(v_winner.years_exp, v_loser.years_exp),
    nba_draft_number = COALESCE(v_winner.nba_draft_number, v_loser.nba_draft_number),
    -- A backfill stub has no team or position. Its empty injury status is unknown.
    injury_status = CASE WHEN v_winner.nba_team IS NULL AND v_winner.position IS NULL
      THEN COALESCE(v_winner.injury_status, v_loser.injury_status) ELSE v_winner.injury_status END,
    status = CASE WHEN v_winner.nba_team IS NULL AND v_winner.position IS NULL
      THEN COALESCE(v_loser.status, v_winner.status) ELSE v_winner.status END,
    dynasty_rank = COALESCE(v_winner.dynasty_rank, v_loser.dynasty_rank),
    dynasty_rank_source = CASE WHEN v_winner.dynasty_rank IS NULL
      THEN v_loser.dynasty_rank_source ELSE v_winner.dynasty_rank_source END,
    dynasty_rank_fetched_at = CASE WHEN v_winner.dynasty_rank IS NULL
      THEN v_loser.dynasty_rank_fetched_at ELSE v_winner.dynasty_rank_fetched_at END
  WHERE id = winner_id;

  -- A member who already holds the winner on the active roster keeps that row,
  -- so their listings, lineups, pending drops and offers move to the winner
  -- before their loser row goes; the roster lifecycle trigger then finds
  -- nothing of theirs under the old identity. Every other member's state is
  -- cleared by that trigger when their loser row is deleted below, or moves
  -- with their roster row when it is re-pointed.
  DELETE FROM trade_block_items AS stale
    WHERE stale.player_id = loser_id
      AND EXISTS (
        SELECT 1 FROM trade_block_items AS kept
         WHERE kept.league_id = stale.league_id
           AND kept.member_id = stale.member_id
           AND kept.player_id = winner_id
      );
  UPDATE trade_block_items AS listing
     SET player_id = winner_id
   WHERE listing.player_id = loser_id
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
         JOIN league_seasons AS season ON season.id = own.league_season_id AND season.is_current = true
        WHERE own.player_id = winner_id AND own.member_id = listing.member_id AND own.league_id = listing.league_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  DELETE FROM weekly_lineups
    WHERE player_id = loser_id
      AND (league_id, league_season_id, member_id, game_date) IN (
        SELECT league_id, league_season_id, member_id, game_date
          FROM weekly_lineups WHERE player_id = winner_id
      );
  UPDATE weekly_lineups AS lineup
     SET player_id = winner_id
   WHERE lineup.player_id = loser_id
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = lineup.member_id AND own.league_season_id = lineup.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  UPDATE waiver_claims AS claim
     SET drop_player_id = winner_id
   WHERE claim.drop_player_id = loser_id
     AND claim.status = 'pending'::waiver_claim_status
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = claim.member_id AND own.league_season_id = claim.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  UPDATE trade_items AS item
     SET player_id = winner_id
    FROM trades AS trade
   WHERE trade.id = item.trade_id
     AND item.player_id = loser_id
     AND trade.status IN ('pending'::trade_status, 'accepted'::trade_status)
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = item.from_member_id AND own.league_season_id = trade.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  -- roster_players: drop the loser's rows that already have a winner row in the
  -- same (league, season), then re-point the rest.
  DELETE FROM roster_players
    WHERE player_id = loser_id
      AND (league_id, league_season_id) IN (
        SELECT league_id, league_season_id FROM roster_players WHERE player_id = winner_id
      );
  UPDATE roster_players SET player_id = winner_id WHERE player_id = loser_id;

  -- Everything still under the loser identity belongs to a re-pointed roster
  -- row or to history; it moves with the identity.
  UPDATE trade_block_items SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE weekly_lineups    SET player_id = winner_id WHERE player_id = loser_id;

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
