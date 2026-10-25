CREATE OR REPLACE FUNCTION public.notif_admit_delivery_atomic(p_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.notification_outbox%ROWTYPE;
  reason text;
  deferred_until timestamptz;
BEGIN
  SELECT * INTO r FROM public.notification_outbox WHERE id = p_id AND claim_token = p_claim_token FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.notification_outbox WHERE id = p_id AND suppressed_at IS NOT NULL) THEN RETURN false; END IF;
    RAISE EXCEPTION 'Notification delivery lease lost';
  END IF;
  IF r.delivered_at IS NOT NULL OR r.dead_lettered_at IS NOT NULL OR r.suppressed_at IS NOT NULL OR r.expo_ticket_id IS NOT NULL THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
    WHERE member.id=r.member_id AND league.deleted_at IS NOT NULL) THEN
    reason := 'league_deleted';
  ELSIF private.notif_is_stale(r.event_type,r.data) THEN
    reason := 'stale';
  ELSE
    deferred_until := private.notif_draft_deferred_until(r.event_type,r.data);
    IF deferred_until IS NOT NULL THEN
      UPDATE public.notification_outbox SET available_at=CASE WHEN deferred_until='infinity'::timestamptz THEN clock_timestamp() ELSE deferred_until END,claimed_at=NULL,claim_token=NULL WHERE id=r.id;
      RETURN false;
    END IF;
    IF NOT private.notif_preference_enabled((SELECT user_id FROM public.league_members WHERE id = r.member_id),r.event_type,r.category) THEN
      reason := 'preferences_disabled';
    END IF;
  END IF;
  IF reason IS NOT NULL THEN
    UPDATE public.notification_outbox SET suppressed_at = clock_timestamp(), suppression_reason = reason,
      claimed_at = NULL, claim_token = NULL WHERE id = r.id;
    RETURN false;
  END IF;
  UPDATE public.notification_outbox SET admitted_at=COALESCE(admitted_at,clock_timestamp()) WHERE id=r.id;
  RETURN true;
END;
$$;
