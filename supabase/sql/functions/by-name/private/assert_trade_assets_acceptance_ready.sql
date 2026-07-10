-- Canonical SQL source for private.assert_trade_assets_acceptance_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM trade_items AS item
    JOIN roster_players AS roster
      ON roster.league_id = p_league_id
     AND roster.league_season_id = p_league_season_id
     AND roster.member_id = item.from_member_id
     AND roster.player_id = item.player_id
   WHERE item.trade_id = p_trade_id
     AND item.player_id IS NOT NULL
   ORDER BY roster.id
   FOR UPDATE OF roster;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM roster_players AS roster
          WHERE roster.league_id = p_league_id
            AND roster.league_season_id = p_league_season_id
            AND roster.member_id = item.from_member_id
            AND roster.player_id = item.player_id
            AND roster.is_on_ir = false
            AND roster.is_on_taxi = false
       )
  ) THEN
    RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trade_items AS accepted_item
        ON accepted_item.player_id = item.player_id
       AND accepted_item.from_member_id = item.from_member_id
      JOIN trades AS accepted_trade
        ON accepted_trade.id = accepted_item.trade_id
       AND accepted_trade.status = 'accepted'::trade_status
       AND accepted_trade.league_id = p_league_id
       AND accepted_trade.league_season_id = p_league_season_id
     WHERE item.trade_id = p_trade_id
       AND item.player_id IS NOT NULL
       AND accepted_trade.id <> p_trade_id
  ) THEN
    RAISE EXCEPTION 'Player asset is reserved for another accepted trade';
  END IF;

  PERFORM 1
    FROM trade_items AS item
    JOIN draft_picks AS pick
      ON pick.id = item.pick_id
     AND pick.league_id = p_league_id
     AND pick.current_owner_id = item.from_member_id
     AND pick.is_used = false
   WHERE item.trade_id = p_trade_id
     AND item.pick_id IS NOT NULL
   ORDER BY pick.id
   FOR UPDATE OF pick;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
     WHERE item.trade_id = p_trade_id
       AND item.pick_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM draft_picks AS pick
          WHERE pick.id = item.pick_id
            AND pick.league_id = p_league_id
            AND pick.current_owner_id = item.from_member_id
            AND pick.is_used = false
       )
  ) THEN
    RAISE EXCEPTION 'Draft-pick asset is no longer owned by the expected trade side';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trade_items AS accepted_item
        ON accepted_item.pick_id = item.pick_id
       AND accepted_item.from_member_id = item.from_member_id
      JOIN trades AS accepted_trade
        ON accepted_trade.id = accepted_item.trade_id
       AND accepted_trade.status = 'accepted'::trade_status
       AND accepted_trade.league_id = p_league_id
       AND accepted_trade.league_season_id = p_league_season_id
     WHERE item.trade_id = p_trade_id
       AND item.pick_id IS NOT NULL
       AND accepted_trade.id <> p_trade_id
  ) THEN
    RAISE EXCEPTION 'Draft-pick asset is reserved for another accepted trade';
  END IF;
END;
$$;
