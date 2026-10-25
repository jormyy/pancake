SET lock_timeout = '5s';
SET statement_timeout = '2min';

ALTER TABLE public.notification_preferences
  ADD COLUMN master_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN category_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN event_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT notif_category_object CHECK (jsonb_typeof(category_settings) = 'object'),
  ADD CONSTRAINT notif_event_object CHECK (jsonb_typeof(event_settings) = 'object');

UPDATE public.notification_preferences SET category_settings = jsonb_build_object(
  'trade',trade_enabled,'waiver',waiver_enabled,'draft',draft_enabled,
  'player',activity_enabled,'lineup',activity_enabled,'matchup',activity_enabled,
  'playoff',activity_enabled,'league',activity_enabled);

CREATE TABLE public.notif_event_catalog (
  event_type text PRIMARY KEY,
  category text NOT NULL,
  label text NOT NULL,
  default_enabled boolean NOT NULL,
  legacy_column text NOT NULL
);
ALTER TABLE public.notif_event_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notif_event_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notif_event_catalog TO service_role;

INSERT INTO public.notif_event_catalog(event_type,category,label,default_enabled,legacy_column) VALUES
  ('trade_offered','trade','New offer',true,'trade_enabled'),
  ('trade_countered','trade','Counteroffer',true,'trade_enabled'),
  ('trade_accepted','trade','Accepted',true,'trade_enabled'),
  ('trade_rejected','trade','Rejected',true,'trade_enabled'),
  ('trade_vetoed','trade','Vetoed',true,'trade_enabled'),
  ('trade_expired','trade','Expired',true,'trade_enabled'),
  ('trade_edited','trade','Offer edited',true,'trade_enabled'),
  ('trade_withdrawn','trade','Withdrawn',true,'trade_enabled'),
  ('trade_completed','trade','Completed',true,'trade_enabled'),
  ('trade_participant_accepted','trade','Participant accepted',true,'trade_enabled'),
  ('trade_completion_failed','trade','Completion failed',true,'trade_enabled'),
  ('trade_claim_cancelled','trade','Claim cancelled',true,'trade_enabled'),
  ('league_trade','trade','Other league trades',false,'trade_enabled'),
  ('draft_on_clock','draft','Your turn',true,'draft_enabled'),
  ('draft_coming_soon','draft','Your pick is next',false,'draft_enabled'),
  ('draft_timer_expiring','draft','Timer expiring',false,'draft_enabled'),
  ('draft_auto_picked','draft','Auto-picked for you',false,'draft_enabled'),
  ('draft_started','draft','Started',false,'draft_enabled'),
  ('draft_paused','draft','Paused',false,'draft_enabled'),
  ('draft_resumed','draft','Resumed',false,'draft_enabled'),
  ('draft_finished','draft','Finished',false,'draft_enabled'),
  ('waiver_claim_won','waiver','Claim won',true,'waiver_enabled'),
  ('waiver_claim_lost','waiver','Claim lost',true,'waiver_enabled'),
  ('faab_outbid','waiver','FAAB outbid',false,'waiver_enabled'),
  ('waivers_processed','waiver','Waivers processed',false,'waiver_enabled'),
  ('watched_player_dropped','waiver','Watched player dropped',false,'waiver_enabled'),
  ('waiver_limit_reached','waiver','Weekly limit reached',false,'waiver_enabled'),
  ('owned_player_injured','player','Player injured',false,'activity_enabled'),
  ('owned_player_status','player','Player status changed',false,'activity_enabled'),
  ('owned_player_ruled_out','player','Player ruled out',false,'activity_enabled'),
  ('lineup_inactive','lineup','Inactive starter',false,'activity_enabled'),
  ('lineup_empty','lineup','Empty starter',false,'activity_enabled'),
  ('matchup_final','matchup','Final result',true,'activity_enabled'),
  ('matchup_started','matchup','Started',false,'activity_enabled'),
  ('matchup_close','matchup','Close late in week',false,'activity_enabled'),
  ('playoff_clinched','playoff','Clinched',false,'activity_enabled'),
  ('playoff_eliminated','playoff','Eliminated',false,'activity_enabled'),
  ('playoff_seeding','playoff','Seeding',false,'activity_enabled'),
  ('champion','playoff','Champion',false,'activity_enabled'),
  ('trade_deadline_approaching','league','Trade deadline soon',false,'activity_enabled'),
  ('season_started','league','Season started',false,'activity_enabled'),
  ('season_rollover','league','New season',false,'activity_enabled'),
  ('commissioner_announcement','league','Commissioner message',false,'activity_enabled'),
  ('league_settings_changed','league','Settings changed',false,'activity_enabled');

ALTER TABLE public.notification_outbox DROP CONSTRAINT notification_outbox_category_known;
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_category_known
  CHECK (category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league'));
ALTER TABLE public.notification_outbox
  ADD COLUMN suppressed_at timestamptz,
  ADD COLUMN suppression_reason text,
  ADD COLUMN web_attempted_at timestamptz,
  ADD COLUMN web_delivered_at timestamptz,
  ADD COLUMN web_failed_at timestamptz;

CREATE OR REPLACE FUNCTION private.notif_preference_enabled(p_user_id uuid, p_event text, p_category text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  p public.notification_preferences%ROWTYPE;
  e public.notif_event_catalog%ROWTYPE;
  v_legacy text;
BEGIN
  SELECT * INTO p FROM public.notification_preferences WHERE user_id = p_user_id;
  IF p.master_enabled IS FALSE THEN RETURN false; END IF;
  SELECT * INTO e FROM public.notif_event_catalog WHERE event_type = p_event;
  v_legacy := COALESCE(e.legacy_column, CASE p_category
    WHEN 'trade' THEN 'trade_enabled' WHEN 'draft' THEN 'draft_enabled'
    WHEN 'waiver' THEN 'waiver_enabled' ELSE 'activity_enabled' END);
  IF (to_jsonb(p)->>v_legacy)::boolean IS FALSE THEN RETURN false; END IF;
  IF (p.category_settings->>COALESCE(e.category,p_category))::boolean IS FALSE THEN RETURN false; END IF;
  RETURN COALESCE((p.event_settings->>p_event)::boolean,e.default_enabled,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_suppress_atomic(p_id uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.notification_outbox SET suppressed_at = now(), suppression_reason = 'preferences_disabled',
    claimed_at = NULL, claim_token = NULL
  WHERE id = p_id AND claim_token = p_claim_token AND delivered_at IS NULL AND suppressed_at IS NULL
    AND dead_lettered_at IS NULL AND expo_ticket_id IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_begin_web_atomic(p_id uuid, p_claim_token uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.notification_outbox%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.notification_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.claim_token IS DISTINCT FROM p_claim_token OR r.delivered_at IS NOT NULL
    OR r.suppressed_at IS NOT NULL OR r.dead_lettered_at IS NOT NULL THEN RETURN 'lost'; END IF;
  IF r.web_delivered_at IS NOT NULL THEN RETURN 'delivered'; END IF;
  IF r.web_attempted_at IS NOT NULL THEN RETURN 'attempted'; END IF;
  UPDATE public.notification_outbox SET web_attempted_at = now() WHERE id = p_id;
  RETURN 'send';
END;
$$;

CREATE OR REPLACE FUNCTION public.notif_finish_web_atomic(p_id uuid, p_claim_token uuid, p_sent boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.notification_outbox SET web_delivered_at = CASE WHEN p_sent THEN now() ELSE web_delivered_at END,
    web_failed_at = CASE WHEN NOT p_sent THEN now() ELSE web_failed_at END
  WHERE id = p_id AND claim_token = p_claim_token AND web_attempted_at IS NOT NULL;
  RETURN FOUND;
END;
$$;

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
       AND private.notif_preference_enabled((SELECT user_id FROM public.league_members WHERE id = queued.member_id),queued.event_type,queued.category)
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

CREATE OR REPLACE FUNCTION public.complete_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET delivered_at = now(),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_notification_receipts_atomic(
  p_limit int DEFAULT 200,
  p_lease_seconds int DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  claim_token uuid,
  member_id uuid,
  expo_ticket_id text,
  push_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 200), 0), 1000);
  v_lease_seconds int := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 15), 600);
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT queued.id
      FROM notification_outbox AS queued
     WHERE queued.suppressed_at IS NULL
       AND queued.delivered_at IS NULL
       AND queued.dead_lettered_at IS NULL
       AND queued.expo_ticket_id IS NOT NULL
       AND queued.available_at <= now()
       AND (
         queued.claimed_at IS NULL
         OR queued.claimed_at <= now() - make_interval(secs => v_lease_seconds)
       )
     ORDER BY queued.available_at, queued.ticketed_at, queued.id
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE notification_outbox AS queued
       SET claimed_at = now(),
           claim_token = gen_random_uuid()
      FROM candidates
     WHERE queued.id = candidates.id
     RETURNING queued.id, queued.claim_token, queued.member_id,
       queued.expo_ticket_id, queued.push_token
  )
  SELECT claimed.id, claimed.claim_token, claimed.member_id,
    claimed.expo_ticket_id, claimed.push_token
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET attempt_count = attempt_count + 1,
         available_at = now() + make_interval(
           secs => LEAST(3600, power(2, LEAST(attempt_count, 12))::int)
         ),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         receipt_attempt_count = 0,
         dead_lettered_at = CASE WHEN attempt_count + 1 >= 12 THEN now() ELSE NULL END,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Unknown notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_notification_outbox_ticket_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_expo_ticket_id text,
  p_push_token text,
  p_receipt_delay_seconds int DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delay int := LEAST(GREATEST(COALESCE(p_receipt_delay_seconds, 900), 0), 3600);
BEGIN
  IF p_expo_ticket_id IS NULL OR p_expo_ticket_id = '' OR octet_length(p_expo_ticket_id) > 200 OR
     p_push_token IS NULL OR p_push_token = '' OR octet_length(p_push_token) > 512 THEN
    RAISE EXCEPTION 'Invalid Expo ticket state.' USING ERRCODE = '22023';
  END IF;

  UPDATE notification_outbox
     SET expo_ticket_id = p_expo_ticket_id,
         push_token = p_push_token,
         ticketed_at = now(),
         receipt_attempt_count = 0,
         available_at = now() + make_interval(secs => v_delay),
         claimed_at = NULL,
         claim_token = NULL,
         last_error = NULL
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL
     AND expo_ticket_id IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.dead_letter_notification_outbox_atomic(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notification_outbox
     SET dead_lettered_at = now(),
         expo_ticket_id = NULL,
         push_token = NULL,
         ticketed_at = NULL,
         claimed_at = NULL,
         claim_token = NULL,
         last_error = left(COALESCE(p_error, 'Permanent notification delivery failure'), 2000)
   WHERE id = p_id
     AND claim_token = p_claim_token
     AND suppressed_at IS NULL
     AND delivered_at IS NULL
     AND dead_lettered_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.notif_suppress_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_suppress_atomic(uuid,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.notif_begin_web_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_begin_web_atomic(uuid,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.notif_finish_web_atomic(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_finish_web_atomic(uuid,uuid,boolean) TO service_role;

REVOKE ALL ON FUNCTION private.notif_preference_enabled(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.notif_preference_enabled(uuid,text,text) TO service_role;

RESET statement_timeout;
RESET lock_timeout;
