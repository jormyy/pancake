-- Keep the legacy standard-trade producer compatible with participant-owned routes
-- before the following migration backfills and switches the acceptance consumer.

SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE OR REPLACE FUNCTION private.route_legacy_standard_trade_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_trade public.trades%ROWTYPE;
BEGIN
  IF NEW.from_member_id IS NOT NULL AND NEW.to_member_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_trade
    FROM public.trades
   WHERE id = NEW.trade_id;

  IF NOT FOUND OR COALESCE(v_trade.is_multi_team, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.side = 'proposer'::public.trade_side THEN
    NEW.from_member_id := v_trade.proposer_member_id;
    NEW.to_member_id := v_trade.recipient_member_id;
  ELSE
    NEW.from_member_id := v_trade.recipient_member_id;
    NEW.to_member_id := v_trade.proposer_member_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER route_legacy_standard_trade_item
  BEFORE INSERT ON public.trade_items
  FOR EACH ROW
  EXECUTE FUNCTION private.route_legacy_standard_trade_item();

CREATE OR REPLACE FUNCTION private.seed_legacy_standard_trade_routes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_multi_team, false) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
  VALUES
    (NEW.id, NEW.proposer_member_id, 0, true, NEW.proposed_at),
    (
      NEW.id,
      NEW.recipient_member_id,
      1,
      false,
      CASE
        WHEN NEW.status IN (
          'accepted'::public.trade_status,
          'completed'::public.trade_status,
          'vetoed'::public.trade_status
        ) THEN NEW.accepted_at
        ELSE NULL
      END
    )
  ON CONFLICT (trade_id, member_id) DO NOTHING;

  INSERT INTO public.trade_items (
    trade_id,
    side,
    from_member_id,
    to_member_id,
    faab_amount
  )
  SELECT
    NEW.id,
    route.side,
    route.from_member_id,
    route.to_member_id,
    route.faab_amount
  FROM (
    VALUES
      (
        'proposer'::public.trade_side,
        NEW.proposer_member_id,
        NEW.recipient_member_id,
        NEW.proposer_faab_amount
      ),
      (
        'recipient'::public.trade_side,
        NEW.recipient_member_id,
        NEW.proposer_member_id,
        NEW.recipient_faab_amount
      )
  ) AS route(side, from_member_id, to_member_id, faab_amount)
  WHERE route.faab_amount > 0;

  RETURN NEW;
END;
$$;

CREATE TRIGGER seed_legacy_standard_trade_routes
  AFTER INSERT ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION private.seed_legacy_standard_trade_routes();

RESET statement_timeout;
RESET lock_timeout;
