SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE OR REPLACE FUNCTION private.enqueue_trade_status_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_type text;
  v_title text;
  v_body text;
  v_single_recipient uuid;
  v_all_participants boolean := false;
BEGIN
  IF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'completed'::public.trade_status THEN
    v_event_type := 'trade_completed';
    v_title := 'Trade Completed';
    v_body := 'Assets have moved. Check your roster.';
    v_all_participants := true;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'rejected'::public.trade_status THEN
    v_event_type := 'trade_rejected';
    v_title := 'Trade Rejected';
    v_body := 'Your trade offer was declined.';
    v_single_recipient := NEW.proposer_member_id;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'withdrawn'::public.trade_status THEN
    v_event_type := 'trade_withdrawn';
    v_title := 'Trade Withdrawn';
    v_body := 'A trade offer sent to you has been withdrawn.';
    v_all_participants := COALESCE(NEW.is_multi_team, false);
    v_single_recipient := NEW.recipient_member_id;
  ELSIF OLD.status = 'pending'::public.trade_status AND NEW.status = 'expired'::public.trade_status THEN
    v_event_type := 'trade_expired';
    v_title := 'Trade Expired';
    v_body := 'One of your pending trade offers expired.';
    v_all_participants := true;
  ELSIF OLD.status = 'accepted'::public.trade_status AND NEW.status = 'vetoed'::public.trade_status THEN
    v_event_type := 'trade_vetoed';
    v_title := 'Trade Vetoed';
    v_body := 'An accepted trade was vetoed before completion.';
    v_all_participants := true;
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.notification_outbox (
    dedupe_key,
    member_id,
    event_type,
    title,
    body,
    data,
    category
  )
  SELECT
    format('%s:%s:%s', v_event_type, NEW.id, recipient.member_id),
    recipient.member_id,
    v_event_type,
    v_title,
    v_body,
    jsonb_build_object('tradeId', NEW.id),
    'trade'
  FROM (
    SELECT participant.member_id
      FROM public.trade_participants AS participant
     WHERE participant.trade_id = NEW.id
       AND v_all_participants
       AND (v_event_type <> 'trade_withdrawn' OR participant.member_id <> NEW.proposer_member_id)
    UNION SELECT v_single_recipient WHERE NOT v_all_participants
  ) AS recipient
  WHERE recipient.member_id IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN NEW;
END;
$$;

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

DROP TRIGGER IF EXISTS enqueue_trade_participant_notification ON public.trade_participants;
CREATE TRIGGER enqueue_trade_participant_notification
  AFTER INSERT OR UPDATE OF accepted_at ON public.trade_participants
  FOR EACH ROW
  EXECUTE FUNCTION private.enqueue_trade_participant_notification();

REVOKE ALL ON FUNCTION private.enqueue_trade_status_notification() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.enqueue_trade_participant_notification() FROM PUBLIC, anon, authenticated, service_role;

RESET statement_timeout;
RESET lock_timeout;
