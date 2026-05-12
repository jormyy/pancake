-- Harden roster ownership RLS and add an atomic trade acceptance path.
--
-- Findings:
-- - P0-2: league-wide roster_players update/delete let any league member mutate
--   any roster row in that league.
-- - P0-3: client-side trade acceptance can partially move player rows before
--   draft-pick moves fail.

DROP POLICY IF EXISTS "roster_players_update" ON roster_players;
DROP POLICY IF EXISTS "roster_players_delete" ON roster_players;

-- Clients may only update their own roster rows, and only the mutable placement
-- flags should be grantable to authenticated users. Ownership transfer is a
-- privileged server/RPC operation.
REVOKE UPDATE ON roster_players FROM authenticated;
GRANT UPDATE (is_on_ir, is_on_taxi) ON roster_players TO authenticated;

CREATE POLICY "roster_players_update_own" ON roster_players
  FOR UPDATE TO authenticated
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  )
  WITH CHECK (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  );

CREATE POLICY "roster_players_delete_own" ON roster_players
  FOR DELETE TO authenticated
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND member_id IN (SELECT private.my_member_ids())
  );

CREATE OR REPLACE FUNCTION public.accept_trade_atomic(
  p_trade_id uuid,
  p_accepting_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_item trade_items%ROWTYPE;
  v_from_member uuid;
  v_to_member uuid;
  v_rows int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found';
  END IF;

  IF v_trade.status <> 'pending' THEN
    RAISE EXCEPTION 'This trade is no longer pending';
  END IF;

  IF v_trade.recipient_member_id <> p_accepting_member_id THEN
    RAISE EXCEPTION 'Only the recipient can accept this trade';
  END IF;

  -- Validate and lock every asset before applying any mutation.
  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      PERFORM 1
        FROM roster_players
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Player asset is no longer owned by the expected trade side';
      END IF;
    ELSE
      PERFORM 1
        FROM draft_picks
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
      END IF;
    END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM trade_items WHERE trade_id = p_trade_id ORDER BY created_at, id
  LOOP
    v_from_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.proposer_member_id
      ELSE v_trade.recipient_member_id
    END;
    v_to_member := CASE
      WHEN v_item.side = 'proposer' THEN v_trade.recipient_member_id
      ELSE v_trade.proposer_member_id
    END;

    IF v_item.player_id IS NOT NULL THEN
      UPDATE roster_players
         SET member_id = v_to_member,
             acquired_via = 'trade'
       WHERE league_id = v_trade.league_id
         AND league_season_id = v_trade.league_season_id
         AND member_id = v_from_member
         AND player_id = v_item.player_id;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move player asset atomically';
      END IF;

      INSERT INTO roster_transactions (
        league_id,
        league_season_id,
        member_id,
        player_id,
        transaction_type,
        related_trade_id
      )
      VALUES
        (v_trade.league_id, v_trade.league_season_id, v_from_member, v_item.player_id, 'trade_out', p_trade_id),
        (v_trade.league_id, v_trade.league_season_id, v_to_member, v_item.player_id, 'trade_in', p_trade_id);
    ELSE
      UPDATE draft_picks
         SET current_owner_id = v_to_member
       WHERE id = v_item.pick_id
         AND league_id = v_trade.league_id
         AND current_owner_id = v_from_member
         AND is_used = false;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Failed to move draft-pick asset atomically';
      END IF;
    END IF;
  END LOOP;

  UPDATE trades
     SET status = 'completed',
         accepted_at = now(),
         completed_at = now()
   WHERE id = p_trade_id
     AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to complete trade atomically';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_trade_atomic(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_atomic(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.advance_season_atomic(p_league_id uuid)
RETURNS TABLE(new_season_id uuid, new_year int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_season league_seasons%ROWTYPE;
  v_new_season_id uuid;
  v_new_year int;
  v_far_year int;
BEGIN
  PERFORM 1 FROM leagues WHERE id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found for this league';
  END IF;

  v_new_year := v_current_season.season_year + 1;
  v_far_year := v_new_year + 5;

  IF EXISTS (
    SELECT 1
      FROM league_seasons
     WHERE league_id = p_league_id
       AND season_year = v_new_year
  ) THEN
    RAISE EXCEPTION 'Season % already exists', v_new_year;
  END IF;

  UPDATE league_seasons
     SET is_current = false
   WHERE id = v_current_season.id;

  INSERT INTO league_seasons (league_id, season_year, is_current)
  VALUES (p_league_id, v_new_year, true)
  RETURNING id INTO v_new_season_id;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    'carry_over'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_current_season.id;

  INSERT INTO draft_picks (
    league_id,
    season_year,
    round,
    original_owner_id,
    current_owner_id
  )
  SELECT
    p_league_id,
    v_far_year,
    round_value,
    lm.id,
    lm.id
  FROM league_members lm
  CROSS JOIN unnest(ARRAY[1, 2, 3]) AS round_value
  WHERE lm.league_id = p_league_id
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  INSERT INTO waiver_priorities (
    league_id,
    league_season_id,
    member_id,
    priority
  )
  WITH latest_standings AS (
    SELECT DISTINCT ON (member_id)
      member_id,
      wins,
      losses,
      points_for,
      points_against
    FROM standings
    WHERE league_id = p_league_id
      AND league_season_id = v_current_season.id
    ORDER BY member_id, week_number DESC
  ),
  ordered_members AS (
    SELECT
      lm.id AS member_id,
      row_number() OVER (
        ORDER BY
          COALESCE(ls.wins, 0) ASC,
          COALESCE(ls.points_for, 0) ASC,
          COALESCE(ls.losses, 0) DESC,
          COALESCE(ls.points_against, 0) DESC,
          lm.id ASC
      ) AS priority
    FROM league_members lm
    LEFT JOIN latest_standings ls ON ls.member_id = lm.id
    WHERE lm.league_id = p_league_id
  )
  SELECT p_league_id, v_new_season_id, member_id, priority
  FROM ordered_members;

  UPDATE leagues
     SET status = 'offseason'
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.advance_season_atomic(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.advance_season_atomic(uuid) TO service_role;

-- Live scoreboard paths poll by game_date first, then key results by player.
CREATE INDEX IF NOT EXISTS idx_pgs_game_date_player
  ON player_game_stats(game_date, player_id);
