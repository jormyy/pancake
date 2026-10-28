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
  RETURN QUERY
  WITH pending AS MATERIALIZED (
    SELECT queued.id, queued.member_id, queued.event_type, queued.data, queued.category,
      queued.available_at, queued.created_at, member.user_id, league.deleted_at
    FROM public.notification_outbox queued
    JOIN public.league_members member ON member.id=queued.member_id
    JOIN public.leagues league ON league.id=member.league_id
    WHERE queued.delivered_at IS NULL AND queued.dead_lettered_at IS NULL
      AND queued.suppressed_at IS NULL AND queued.expo_ticket_id IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.available_at<=now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at<=now()-make_interval(secs=>v_lease_seconds))
    ORDER BY queued.available_at,queued.created_at,queued.id
    LIMIT CASE WHEN v_limit=0 THEN 0 ELSE GREATEST(v_limit,100) END
    FOR UPDATE OF queued SKIP LOCKED
  ), stale AS MATERIALIZED (
    SELECT pending.*, CASE WHEN pending.deleted_at IS NOT NULL THEN 'league_deleted'
      WHEN private.notif_is_stale(pending.event_type,pending.data) THEN 'stale' END AS reason
    FROM pending
  ), deferred AS MATERIALIZED (
    SELECT stale.*, CASE WHEN stale.reason IS NULL THEN private.notif_draft_deferred_until(stale.event_type,stale.data) END AS resume_at
    FROM stale
  ), classified AS MATERIALIZED (
    SELECT deferred.*, CASE WHEN deferred.reason IS NOT NULL THEN deferred.reason
      WHEN deferred.resume_at IS NULL AND NOT private.notif_preference_enabled(deferred.user_id,deferred.event_type,deferred.category)
        THEN 'preferences_disabled' END AS suppression
    FROM deferred
  ), delivery AS MATERIALIZED (
    SELECT classified.id FROM classified WHERE classified.suppression IS NULL AND classified.resume_at IS NULL
    ORDER BY classified.available_at,classified.created_at,classified.id LIMIT v_limit
  ), changed AS (
    UPDATE public.notification_outbox queued SET
      suppressed_at=CASE WHEN classified.suppression IS NOT NULL THEN clock_timestamp() ELSE queued.suppressed_at END,
      suppression_reason=COALESCE(classified.suppression,queued.suppression_reason),
      available_at=CASE WHEN classified.resume_at IS NOT NULL AND classified.suppression IS NULL
        THEN LEAST(classified.resume_at,clock_timestamp()+interval '1 minute') ELSE queued.available_at END,
      claimed_at=CASE WHEN delivery.id IS NOT NULL THEN clock_timestamp() ELSE NULL END,
      claim_token=CASE WHEN delivery.id IS NOT NULL THEN gen_random_uuid() ELSE NULL END
    FROM classified LEFT JOIN delivery ON delivery.id=classified.id
    WHERE queued.id=classified.id AND (classified.suppression IS NOT NULL OR classified.resume_at IS NOT NULL OR delivery.id IS NOT NULL)
    RETURNING queued.*
  )
  SELECT changed.id,changed.claim_token,changed.member_id,changed.title,changed.body,
    changed.data||jsonb_build_object('notificationEvent',changed.event_type,'outboxId',changed.id),changed.category
  FROM changed JOIN delivery ON delivery.id=changed.id
  ORDER BY changed.available_at,changed.created_at,changed.id;
END;
$$;
