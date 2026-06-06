CREATE OR REPLACE FUNCTION private.prevent_reserved_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF (
    OLD.member_id IS DISTINCT FROM NEW.member_id OR
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = OLD.league_id
       AND trade.league_season_id = OLD.league_season_id
       AND item.player_id = OLD.player_id
       AND CASE
         WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id
         ELSE trade.recipient_member_id
       END = OLD.member_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (
    OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR
    OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi
  ) AND EXISTS (
    SELECT 1
      FROM waiver_claims AS claim
     WHERE claim.status = 'pending'::waiver_claim_status
       AND claim.league_id = OLD.league_id
       AND claim.league_season_id = OLD.league_season_id
       AND claim.member_id = OLD.member_id
       AND claim.drop_player_id = OLD.player_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as a pending waiver drop.'
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.member_id IS DISTINCT FROM NEW.member_id AND (
    OLD.is_on_ir = true OR
    OLD.is_on_taxi = true OR
    NEW.is_on_ir = true OR
    NEW.is_on_taxi = true
  ) THEN
    RAISE EXCEPTION 'Inactive roster players must be activated before they can be traded.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_reserved_or_inactive_roster_move ON public.roster_players;
CREATE TRIGGER prevent_reserved_or_inactive_roster_move
  BEFORE UPDATE OF member_id, is_on_ir, is_on_taxi ON public.roster_players
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_reserved_or_inactive_roster_move();

CREATE OR REPLACE FUNCTION private.prevent_reserved_or_inactive_trade_accept()
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
       AND rp.member_id = CASE
         WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id
         ELSE NEW.recipient_member_id
       END
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
          CASE
            WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id
            ELSE NEW.recipient_member_id
          END AS member_id
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
              FROM trade_drop_reservations AS reservation
              JOIN trades AS trade
                ON trade.id = reservation.trade_id
               AND trade.status = 'accepted'::trade_status
             WHERE reservation.roster_player_id = rp.id
               AND reservation.trade_id <> NEW.id
          )
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
               AND CASE
                 WHEN other_item.side = 'proposer'::trade_side THEN other_trade.proposer_member_id
                 ELSE other_trade.recipient_member_id
               END = rp.member_id
          )
    ) THEN
      RAISE EXCEPTION 'Trade player assets must be active and unreserved roster players.'
        USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
      WITH pick_assets AS (
        SELECT
          ti.pick_id,
          CASE
            WHEN ti.side = 'proposer'::trade_side THEN NEW.proposer_member_id
            ELSE NEW.recipient_member_id
          END AS member_id
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
            AND CASE
              WHEN other_item.side = 'proposer'::trade_side THEN other_trade.proposer_member_id
              ELSE other_trade.recipient_member_id
            END = asset.member_id
       )
    ) THEN
      RAISE EXCEPTION 'Trade draft-pick assets must be unreserved.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_reserved_or_inactive_trade_accept ON public.trades;
CREATE TRIGGER prevent_reserved_or_inactive_trade_accept
  BEFORE UPDATE OF status ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_reserved_or_inactive_trade_accept();

CREATE OR REPLACE FUNCTION private.prevent_pending_waiver_inactive_drop()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF NEW.drop_player_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM roster_players AS rp
     WHERE rp.league_id = NEW.league_id
       AND rp.league_season_id = NEW.league_season_id
       AND rp.member_id = NEW.member_id
       AND rp.player_id = NEW.drop_player_id
       AND rp.is_on_ir = false
       AND rp.is_on_taxi = false
  ) THEN
    RAISE EXCEPTION 'Waiver drop player must be on the active roster.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_pending_waiver_inactive_drop ON public.waiver_claims;
CREATE TRIGGER prevent_pending_waiver_inactive_drop
  BEFORE INSERT OR UPDATE OF drop_player_id, status ON public.waiver_claims
  FOR EACH ROW
  WHEN (NEW.status = 'pending'::waiver_claim_status)
  EXECUTE FUNCTION private.prevent_pending_waiver_inactive_drop();

CREATE OR REPLACE FUNCTION private.prevent_trade_drop_reserved_asset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = NEW.trade_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE item.trade_id <> NEW.trade_id
       AND item.player_id = NEW.player_id
       AND trade.league_id = v_trade.league_id
       AND trade.league_season_id = v_trade.league_season_id
       AND CASE
         WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id
         ELSE trade.recipient_member_id
       END = NEW.member_id
  ) THEN
    RAISE EXCEPTION 'Trade drop player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_trade_drop_reserved_asset ON public.trade_drop_reservations;
CREATE TRIGGER prevent_trade_drop_reserved_asset
  BEFORE INSERT OR UPDATE OF player_id, member_id, trade_id ON public.trade_drop_reservations
  FOR EACH ROW
  EXECUTE FUNCTION private.prevent_trade_drop_reserved_asset();

CREATE OR REPLACE FUNCTION private.prevent_reserved_drop_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, private
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM trade_drop_reservations AS reservation
      JOIN trades AS trade
        ON trade.id = reservation.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE reservation.roster_player_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved for an accepted trade.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM trade_items AS item
      JOIN trades AS trade
        ON trade.id = item.trade_id
       AND trade.status = 'accepted'::trade_status
     WHERE trade.league_id = OLD.league_id
       AND trade.league_season_id = OLD.league_season_id
       AND item.player_id = OLD.player_id
       AND CASE
         WHEN item.side = 'proposer'::trade_side THEN trade.proposer_member_id
         ELSE trade.recipient_member_id
       END = OLD.member_id
  ) THEN
    RAISE EXCEPTION 'This roster player is reserved as an accepted trade asset.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$$;
