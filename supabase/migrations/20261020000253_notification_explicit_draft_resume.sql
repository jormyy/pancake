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
    IF v_event IS NOT NULL AND v_event<>'draft_resumed' THEN
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

CREATE OR REPLACE FUNCTION private.notif_draft_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  m record;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = NEW.draft_id;
  IF NOT d.is_mock AND NEW.action = 'auto_pick' THEN
    PERFORM private.notif_enqueue('draft_auto_picked',NEW.id::text,d.league_id,(NEW.metadata->>'memberId')::uuid,
      jsonb_build_object('draftId',d.id,'playerId',NEW.metadata->>'playerId'));
  ELSIF NOT d.is_mock AND NEW.action='resume' AND NEW.metadata->>'previousStatus'='paused' AND d.status='in_progress' THEN
    FOR m IN SELECT id FROM public.league_members WHERE league_id=d.league_id LOOP
      PERFORM private.notif_enqueue('draft_resumed',NEW.id::text,d.league_id,m.id,jsonb_build_object('draftId',d.id));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
