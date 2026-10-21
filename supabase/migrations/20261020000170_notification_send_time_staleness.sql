CREATE OR REPLACE FUNCTION private.notif_is_stale(p_event text, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  deadline timestamptz;
BEGIN
  IF p_event NOT IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') THEN RETURN false; END IF;
  IF NOT (p_data ? 'draftId' AND p_data ? 'pickId') THEN RETURN true; END IF;
  SELECT * INTO d FROM public.drafts WHERE id::text = p_data->>'draftId';
  IF d.id IS NULL OR d.is_mock OR d.status <> 'in_progress' THEN RETURN true; END IF;
  SELECT * INTO p FROM public.snake_draft_picks WHERE id::text = p_data->>'pickId' AND draft_id = d.id;
  IF p.id IS NULL OR p.picked_at IS NOT NULL OR p.skipped_at IS NOT NULL THEN RETURN true; END IF;
  SELECT timer_expires_at INTO deadline FROM public.snake_draft_picks
    WHERE draft_id = d.id AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
  RETURN deadline IS NULL OR deadline <= clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_admit_delivery_atomic(p_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.notification_outbox%ROWTYPE;
  reason text;
BEGIN
  SELECT * INTO r FROM public.notification_outbox WHERE id = p_id AND claim_token = p_claim_token FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.notification_outbox WHERE id = p_id AND suppressed_at IS NOT NULL) THEN RETURN false; END IF;
    RAISE EXCEPTION 'Notification delivery lease lost';
  END IF;
  IF r.delivered_at IS NOT NULL OR r.dead_lettered_at IS NOT NULL OR r.suppressed_at IS NOT NULL OR r.expo_ticket_id IS NOT NULL THEN RETURN false; END IF;
  IF NOT private.notif_preference_enabled((SELECT user_id FROM public.league_members WHERE id = r.member_id),r.event_type,r.category) THEN
    reason := 'preferences_disabled';
  ELSIF private.notif_is_stale(r.event_type,r.data) THEN
    reason := 'stale';
  END IF;
  IF reason IS NOT NULL THEN
    UPDATE public.notification_outbox SET suppressed_at = clock_timestamp(), suppression_reason = reason,
      claimed_at = NULL, claim_token = NULL WHERE id = r.id;
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- Canonical SQL source for public.claim_notification_outbox_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_atomic(
  p_limit int DEFAULT 100,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  title text,
  body text,
  data jsonb,
  category text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 200);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  WITH stale AS (
    SELECT queued.id FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= clock_timestamp()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND private.notif_is_stale(queued.event_type,queued.data)
      AND private.notif_preference_enabled((SELECT user_id FROM public.league_members WHERE id = queued.member_id),queued.event_type,queued.category)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = clock_timestamp(), suppression_reason = 'stale',
    claimed_at = NULL, claim_token = NULL FROM stale WHERE queued.id = stale.id;
  WITH disabled AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id = queued.member_id
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND NOT private.notif_preference_enabled(member.user_id,queued.event_type,queued.category)
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at = now(), suppression_reason = 'preferences_disabled',
    claimed_at = NULL, claim_token = NULL FROM disabled WHERE queued.id = disabled.id;
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
       AND queued.suppressed_at IS NULL
       AND NOT private.notif_is_stale(queued.event_type,queued.data)
       AND private.notif_preference_enabled((SELECT member.user_id FROM public.league_members member WHERE member.id = queued.member_id),queued.event_type,queued.category)
       AND queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.expo_ticket_id IS NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.created_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id, queued.title,
       queued.body, queued.data || jsonb_build_object('notificationEvent',queued.event_type,'outboxId',queued.id) AS data, queued.category
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id, claimed.title,
    claimed.body, claimed.data, claimed.category
  FROM claimed;
END;
$$;

REVOKE ALL ON FUNCTION private.notif_is_stale(text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.notif_admit_delivery_atomic(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.notif_admit_delivery_atomic(uuid,uuid) TO service_role;
