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
  WITH deleted AS (
    SELECT queued.id FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id=queued.member_id
    JOIN public.leagues league ON league.id=member.league_id AND league.deleted_at IS NOT NULL
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL AND queued.suppressed_at IS NULL
      AND queued.expo_ticket_id IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at<=now()-make_interval(secs=>v_lease_seconds))
    ORDER BY queued.available_at,queued.id LIMIT v_limit FOR UPDATE OF queued SKIP LOCKED
  )
  UPDATE public.notification_outbox queued SET suppressed_at=clock_timestamp(),suppression_reason='league_deleted',
    claimed_at=NULL,claim_token=NULL FROM deleted WHERE queued.id=deleted.id;
  WITH stale AS (
    SELECT queued.id FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= clock_timestamp()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds))
      AND private.notif_is_stale(queued.event_type,queued.data)
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
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
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
       AND EXISTS (SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
         WHERE member.id=queued.member_id AND league.deleted_at IS NULL)
       AND NOT private.notif_is_stale(queued.event_type,queued.data)
       AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
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
