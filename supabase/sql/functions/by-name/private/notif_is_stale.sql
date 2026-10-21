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
