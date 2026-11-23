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
  v_sender record;
BEGIN
  IF OLD.status = 'pending'::trade_status AND NEW.status = 'accepted'::trade_status THEN
    IF OLD.expires_at IS NOT NULL AND OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'This trade offer has expired.'
        USING ERRCODE = 'P0001';
    END IF;

    FOR v_sender IN
      SELECT item.from_member_id AS member_id, sum(item.faab_amount) AS amount
        FROM trade_items AS item
       WHERE item.trade_id = OLD.id AND item.faab_amount > 0
       GROUP BY item.from_member_id
       ORDER BY item.from_member_id
    LOOP
      IF private.ensure_faab_balance(OLD.league_id, OLD.league_season_id, v_sender.member_id) < v_sender.amount THEN
        RAISE EXCEPTION '%', CASE WHEN v_sender.member_id = OLD.proposer_member_id
          THEN 'Proposer no longer has enough FAAB for this trade.'
          ELSE 'Recipient no longer has enough FAAB for this trade.' END
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;
