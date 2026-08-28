-- Trigger functions that reach private helpers run as their owner.
--
-- Row triggers execute with the caller's privileges, and only postgres may
-- use the private schema. The reservation and lifecycle triggers call
-- private helpers, so a direct roster, pick, or trade write by service_role
-- or authenticated failed with "permission denied for schema private". The
-- four trigger functions that call private helpers are SECURITY DEFINER,
-- like the other lifecycle triggers.

CREATE OR REPLACE FUNCTION private.prevent_accepted_or_inactive_roster_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF OLD.is_on_ir IS DISTINCT FROM NEW.is_on_ir OR OLD.is_on_taxi IS DISTINCT FROM NEW.is_on_taxi THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id);
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

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_asset_roster_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, OLD.league_season_id, OLD.member_id, OLD.player_id);

  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_accepted_trade_pick_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF private.trade_lifecycle_write_active() THEN
    RETURN NEW;
  END IF;

  IF private.pick_left_owner(OLD, NEW) IS NOT NULL THEN
    PERFORM private.assert_not_reserved_trade_asset(OLD.league_id, NULL, OLD.current_owner_id, NULL, OLD.id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_expired_or_unfunded_trade_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance int;
BEGIN
  IF OLD.status = 'pending'::trade_status AND NEW.status = 'accepted'::trade_status THEN
    IF OLD.expires_at IS NOT NULL AND OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'This trade offer has expired.'
        USING ERRCODE = 'P0001';
    END IF;

    IF OLD.proposer_faab_amount > 0 THEN
      v_balance := private.ensure_faab_balance(OLD.league_id, OLD.league_season_id, OLD.proposer_member_id);
      IF v_balance < OLD.proposer_faab_amount THEN
        RAISE EXCEPTION 'Proposer no longer has enough FAAB for this trade.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF OLD.recipient_faab_amount > 0 THEN
      v_balance := private.ensure_faab_balance(OLD.league_id, OLD.league_season_id, OLD.recipient_member_id);
      IF v_balance < OLD.recipient_faab_amount THEN
        RAISE EXCEPTION 'Recipient no longer has enough FAAB for this trade.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
