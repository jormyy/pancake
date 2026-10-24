CREATE OR REPLACE FUNCTION private.notif_is_stale(p_event text, p_data jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  deadline timestamptz;
BEGIN
  IF p_event IN ('lineup_inactive','lineup_empty') THEN
    RETURN NOT EXISTS(SELECT 1 FROM private.notif_lineup_candidates(clock_timestamp()) c
      WHERE c.event_type=p_event AND c.league_id::text=p_data->>'leagueId'
        AND c.member_id::text=p_data->>'memberId' AND c.game_date::text=p_data->>'gameDate'
        AND (p_event='lineup_empty' OR c.player_id::text=p_data->>'playerId'));
  END IF;
  IF p_event='matchup_close' THEN
    RETURN NOT EXISTS(SELECT 1 FROM public.matchups m
      JOIN public.league_seasons s ON s.id=m.league_season_id AND s.is_current
      JOIN public.season_weeks ending ON ending.season_year=s.season_year AND ending.week_number=COALESCE(m.end_week_number,m.week_number)
      WHERE m.id::text=p_data->>'matchupId' AND NOT m.is_finalized AND NOT m.is_voided AND m.winner_member_id IS NULL
        AND NOT m.week_number=ANY(s.skipped_weeks)
        AND (clock_timestamp() AT TIME ZONE 'America/New_York')::date=ending.week_end
        AND m.home_points IS NOT NULL AND m.away_points IS NOT NULL
        AND abs(m.home_points-m.away_points)<=greatest(10,(m.home_points+m.away_points)*0.025));
  END IF;
  IF p_event NOT IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') THEN RETURN false; END IF;
  IF NOT (p_data ? 'draftId' AND p_data ? 'pickId') THEN RETURN true; END IF;
  SELECT * INTO d FROM public.drafts WHERE id::text = p_data->>'draftId';
  IF d.id IS NULL OR d.is_mock OR d.status NOT IN ('in_progress','paused') THEN RETURN true; END IF;
  SELECT * INTO p FROM public.snake_draft_picks WHERE id::text = p_data->>'pickId' AND draft_id = d.id;
  IF p.id IS NULL OR p.picked_at IS NOT NULL OR p.skipped_at IS NOT NULL THEN RETURN true; END IF;
  IF d.status = 'paused' THEN RETURN false; END IF;
  SELECT timer_expires_at INTO deadline FROM public.snake_draft_picks
    WHERE draft_id = d.id AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
  RETURN deadline IS NULL OR deadline <= clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_draft_deferred_until(p_event text, p_data jsonb)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  deadline timestamptz;
BEGIN
  IF p_event NOT IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring') THEN RETURN NULL; END IF;
  IF private.notif_is_stale(p_event,p_data) THEN RETURN NULL; END IF;
  SELECT * INTO d FROM public.drafts WHERE id::text=p_data->>'draftId';
  IF d.status='paused' THEN RETURN 'infinity'::timestamptz; END IF;
  IF p_event='draft_timer_expiring' THEN
    SELECT timer_expires_at INTO deadline FROM public.snake_draft_picks
      WHERE draft_id=d.id AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
    IF deadline>clock_timestamp()+interval '1 minute' THEN RETURN deadline-interval '1 minute'; END IF;
  END IF;
  RETURN NULL;
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
  IF private.notif_is_stale(r.event_type,r.data) THEN
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

CREATE OR REPLACE FUNCTION public.invoke_process_trades_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.notif_scan_due_atomic();
  IF EXISTS (
    SELECT 1 FROM public.trades pending
    WHERE pending.status = 'pending'::public.trade_status
      AND pending.expires_at <= now()
  ) OR EXISTS (
    SELECT 1 FROM public.trades accepted
    JOIN public.league_seasons season ON season.id = accepted.league_season_id
    JOIN public.leagues league ON league.id = accepted.league_id
    WHERE accepted.status = 'accepted'::public.trade_status
      AND accepted.veto_window_expires_at <= now()
      AND season.is_current
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status)
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.suppressed_at IS NULL
      AND queued.category IN ('trade','waiver','draft','activity','player','lineup','matchup','playoff','league')
      AND queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NULL
      AND queued.available_at <= now()
      AND private.notif_draft_deferred_until(queued.event_type,queued.data) IS NULL
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) OR EXISTS (
    SELECT 1 FROM public.notification_outbox queued
    WHERE queued.delivered_at IS NULL
      AND queued.dead_lettered_at IS NULL
      AND queued.expo_ticket_id IS NOT NULL
      AND queued.available_at <= now()
      AND (queued.claimed_at IS NULL OR queued.claimed_at <= now() - interval '60 seconds')
  ) THEN
    PERFORM public.invoke_edge_function('process-trades');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.notif_draft_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event text;
  v_occurrence text;
  deadline timestamptz;
  m record;
BEGIN
  IF NEW.is_mock THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    v_event := CASE WHEN NEW.status = 'in_progress' AND TG_OP = 'UPDATE' AND OLD.status = 'paused' THEN 'draft_resumed'
      WHEN NEW.status = 'in_progress' THEN 'draft_started'
      WHEN NEW.status = 'paused' THEN 'draft_paused' WHEN NEW.status = 'completed' THEN 'draft_finished' END;
    v_occurrence := CASE WHEN v_event IN ('draft_paused','draft_resumed') THEN NEW.id::text || ':' || gen_random_uuid()::text ELSE NEW.id::text END;
    IF v_event IS NOT NULL THEN
      FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.league_id LOOP
        PERFORM private.notif_enqueue(v_event,v_occurrence,NEW.league_id,m.id,jsonb_build_object('draftId',NEW.id));
      END LOOP;
    END IF;
  END IF;
  PERFORM private.notif_draft_clock(NEW.id);
  IF v_event='draft_resumed' THEN
    SELECT timer_expires_at INTO deadline FROM public.snake_draft_picks
      WHERE draft_id=NEW.id AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
    IF deadline>clock_timestamp() THEN
      UPDATE public.notification_outbox SET available_at=greatest(clock_timestamp(),
        CASE WHEN event_type='draft_timer_expiring' THEN deadline-interval '1 minute' ELSE clock_timestamp() END)
        WHERE data->>'draftId'=NEW.id::text
          AND event_type IN ('draft_on_clock','draft_coming_soon','draft_timer_expiring')
          AND delivered_at IS NULL AND dead_lettered_at IS NULL AND suppressed_at IS NULL AND expo_ticket_id IS NULL;
      IF EXISTS (SELECT 1 FROM public.notification_outbox WHERE data->>'draftId'=NEW.id::text AND event_type='draft_on_clock'
        AND delivered_at IS NULL AND dead_lettered_at IS NULL AND suppressed_at IS NULL AND expo_ticket_id IS NULL
        AND NOT private.notif_is_stale(event_type,data)) THEN
        BEGIN
          PERFORM public.invoke_edge_function('process-trades');
        EXCEPTION WHEN OTHERS THEN
          RAISE LOG 'Resumed draft notification wake failed; minute dispatcher will retry: %',SQLSTATE;
        END;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.notif_draft_deferred_until(text,jsonb) FROM PUBLIC, anon, authenticated;
