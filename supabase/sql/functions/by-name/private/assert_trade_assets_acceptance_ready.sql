-- Canonical SQL source for private.assert_trade_assets_acceptance_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_trade_assets_acceptance_ready(
  p_trade_id uuid,
  p_league_id uuid,
  p_league_season_id uuid,
  p_only_member_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM private.validate_trade_rosters(p_trade_id, p_only_member_id);
  PERFORM private.assert_accepted_trade_capacity(p_league_id,p_league_season_id,participant.member_id,p_trade_id)
    FROM trade_participants participant WHERE participant.trade_id=p_trade_id
      AND (p_only_member_id IS NULL OR participant.member_id=p_only_member_id);
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
            AND (EXISTS (SELECT 1 FROM leagues WHERE id=p_league_id AND allow_inactive_trades) OR (roster.is_on_ir = false AND roster.is_on_taxi = false))
       )
  ) THEN
    RAISE EXCEPTION 'Player asset is no longer owned by the expected active roster side';
  END IF;

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, item.player_id, NULL, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.player_id IS NOT NULL;

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

  PERFORM private.assert_not_reserved_trade_asset(p_league_id, p_league_season_id, item.from_member_id, NULL, item.pick_id, p_trade_id)
     FROM trade_items AS item
    WHERE item.trade_id = p_trade_id
      AND item.pick_id IS NOT NULL;
END;
$$;
