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
