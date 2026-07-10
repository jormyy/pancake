-- Canonical SQL source for private.prevent_conflicting_or_inactive_trade_accept.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.prevent_conflicting_or_inactive_trade_accept()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.status = 'accepted'::trade_status AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM 1
      FROM trade_items AS ti
      JOIN roster_players AS rp
        ON rp.league_id = NEW.league_id
       AND rp.league_season_id = NEW.league_season_id
       AND rp.player_id = ti.player_id
       AND rp.member_id = COALESCE(
         ti.from_member_id,
         CASE WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id ELSE NEW.recipient_member_id END
       )
     WHERE ti.trade_id = NEW.id
       AND ti.player_id IS NOT NULL
     FOR UPDATE OF rp;

    PERFORM 1
      FROM trade_items AS ti
      JOIN draft_picks AS pick
        ON pick.id = ti.pick_id
     WHERE ti.trade_id = NEW.id
       AND ti.pick_id IS NOT NULL
     FOR UPDATE OF pick;

    IF EXISTS (
      WITH player_assets AS (
        SELECT
          ti.player_id,
          COALESCE(
            ti.from_member_id,
            CASE WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id ELSE NEW.recipient_member_id END
          ) AS member_id
        FROM trade_items AS ti
        WHERE ti.trade_id = NEW.id
          AND ti.player_id IS NOT NULL
      )
      SELECT 1
        FROM player_assets AS asset
        JOIN roster_players AS rp
          ON rp.league_id = NEW.league_id
         AND rp.league_season_id = NEW.league_season_id
         AND rp.member_id = asset.member_id
         AND rp.player_id = asset.player_id
       WHERE rp.is_on_ir = true
          OR rp.is_on_taxi = true
          OR EXISTS (
            SELECT 1
              FROM trade_items AS other_item
              JOIN trades AS other_trade
                ON other_trade.id = other_item.trade_id
               AND other_trade.status = 'accepted'::trade_status
             WHERE other_trade.id <> NEW.id
               AND other_trade.league_id = NEW.league_id
               AND other_trade.league_season_id = NEW.league_season_id
               AND other_item.player_id = rp.player_id
               AND COALESCE(
                 other_item.from_member_id,
                 CASE
                   WHEN other_item.side = 'proposer'::trade_side THEN other_trade.proposer_member_id
                   ELSE other_trade.recipient_member_id
                 END
               ) = rp.member_id
          )
    ) THEN
      RAISE EXCEPTION 'Trade player assets must be active and unreserved roster players.'
        USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
      WITH pick_assets AS (
        SELECT
          ti.pick_id,
          COALESCE(
            ti.from_member_id,
            CASE WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id ELSE NEW.recipient_member_id END
          ) AS member_id
        FROM trade_items AS ti
        WHERE ti.trade_id = NEW.id
          AND ti.pick_id IS NOT NULL
      )
      SELECT 1
        FROM pick_assets AS asset
        JOIN draft_picks AS pick
          ON pick.id = asset.pick_id
       WHERE EXISTS (
         SELECT 1
           FROM trade_items AS other_item
           JOIN trades AS other_trade
             ON other_trade.id = other_item.trade_id
            AND other_trade.status = 'accepted'::trade_status
          WHERE other_trade.id <> NEW.id
            AND other_trade.league_id = NEW.league_id
            AND other_trade.league_season_id = NEW.league_season_id
            AND other_item.pick_id = asset.pick_id
            AND COALESCE(
              other_item.from_member_id,
              CASE
                WHEN other_item.side = 'proposer'::trade_side THEN other_trade.proposer_member_id
                ELSE other_trade.recipient_member_id
              END
            ) = asset.member_id
       )
    ) THEN
      RAISE EXCEPTION 'Trade draft-pick assets must be unreserved.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
