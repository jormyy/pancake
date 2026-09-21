-- Canonical SQL source for private.prevent_expired_or_unfunded_trade_accept.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
