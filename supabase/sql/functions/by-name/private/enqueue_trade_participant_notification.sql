-- Canonical SQL source for private.enqueue_trade_participant_notification.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.enqueue_trade_participant_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_trade public.trades%ROWTYPE;
  v_event_type text;
  v_title text;
  v_body text;
  v_all_accepted boolean;
BEGIN
  SELECT * INTO v_trade FROM public.trades WHERE id = NEW.trade_id;
  IF NOT FOUND OR v_trade.status <> 'pending'::public.trade_status THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_initiator THEN RETURN NEW; END IF;
    v_event_type := CASE
      WHEN v_trade.countered_from_trade_id IS NOT NULL THEN 'trade_countered'
      WHEN v_trade.edited_from_trade_id IS NOT NULL THEN 'trade_edited'
      ELSE 'trade_offered'
    END;
    v_title := CASE
      WHEN v_event_type = 'trade_countered' THEN CASE WHEN v_trade.is_multi_team THEN 'Multi-Team Trade Countered' ELSE 'Trade Countered' END
      WHEN v_event_type = 'trade_edited' THEN CASE WHEN v_trade.is_multi_team THEN 'Multi-Team Trade Edited' ELSE 'Trade Edited' END
      ELSE CASE WHEN v_trade.is_multi_team THEN 'New Multi-Team Trade' ELSE 'New Trade Offer' END
    END;
    v_body := CASE
      WHEN v_event_type = 'trade_countered' THEN CASE WHEN v_trade.is_multi_team THEN 'A multi-team counteroffer is waiting for your review.' ELSE 'A trade offer was countered and is waiting for your review.' END
      WHEN v_event_type = 'trade_edited' THEN CASE WHEN v_trade.is_multi_team THEN 'A pending multi-team trade offer was updated.' ELSE 'A pending trade offer was updated.' END
      ELSE CASE WHEN v_trade.is_multi_team THEN 'A multi-team trade offer is waiting for your review.' ELSE 'You have a new trade offer waiting for your review.' END
    END;

    INSERT INTO public.notification_outbox (dedupe_key, member_id, event_type, title, body, data, category)
    VALUES (
      format('%s:%s:%s', v_event_type, v_trade.id, NEW.member_id),
      NEW.member_id, v_event_type, v_title, v_body,
      jsonb_build_object('tradeId', v_trade.id), 'trade'
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN NEW;
  END IF;

  IF OLD.accepted_at IS NOT NULL OR NEW.accepted_at IS NULL THEN RETURN NEW; END IF;
  SELECT NOT EXISTS (
    SELECT 1 FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.trade_id AND participant.accepted_at IS NULL
  ) INTO v_all_accepted;

  v_event_type := CASE WHEN v_all_accepted THEN 'trade_accepted' ELSE 'trade_participant_accepted' END;
  v_title := CASE
    WHEN v_all_accepted AND v_trade.is_multi_team THEN 'Multi-Team Trade Accepted'
    WHEN v_all_accepted THEN 'Trade Accepted'
    ELSE 'Trade Participant Accepted'
  END;
  v_body := CASE
    WHEN v_all_accepted AND v_trade.is_multi_team THEN 'Every participant accepted the multi-team trade. Completion will follow your league veto settings.'
    WHEN v_all_accepted THEN 'The trade was accepted. Completion will follow your league veto settings.'
    ELSE 'A participant accepted the multi-team trade offer.'
  END;

  INSERT INTO public.notification_outbox (dedupe_key, member_id, event_type, title, body, data, category)
  SELECT
    format('%s:%s:%s:%s', v_event_type, v_trade.id, NEW.member_id, recipient.member_id),
    recipient.member_id, v_event_type, v_title, v_body,
    jsonb_build_object('tradeId', v_trade.id), 'trade'
  FROM (
    SELECT participant.member_id
      FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.trade_id
       AND participant.member_id <> NEW.member_id
       AND v_all_accepted
    UNION SELECT v_trade.proposer_member_id WHERE NOT v_all_accepted AND v_trade.proposer_member_id <> NEW.member_id
  ) AS recipient
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;
