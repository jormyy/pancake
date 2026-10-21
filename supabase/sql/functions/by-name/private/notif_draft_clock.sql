CREATE OR REPLACE FUNCTION private.notif_draft_clock(p_draft_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  n public.snake_draft_picks%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = p_draft_id;
  IF d.status <> 'in_progress' OR d.is_mock THEN RETURN; END IF;
  SELECT * INTO p FROM public.snake_draft_picks WHERE draft_id = d.id AND picked_at IS NULL AND skipped_at IS NULL
    ORDER BY overall_pick LIMIT 1;
  IF p.id IS NULL OR p.timer_expires_at IS NULL THEN RETURN; END IF;
  PERFORM private.notif_enqueue('draft_on_clock',p.id::text,d.league_id,p.member_id,
    jsonb_build_object('draftId',d.id,'pickId',p.id,'body',format('You are on the clock for pick %s.',p.overall_pick)));
  SELECT * INTO n FROM public.snake_draft_picks WHERE draft_id = d.id AND overall_pick > p.overall_pick
    AND picked_at IS NULL AND skipped_at IS NULL ORDER BY overall_pick LIMIT 1;
  IF n.id IS NOT NULL THEN
    PERFORM private.notif_enqueue('draft_coming_soon',n.id::text,d.league_id,n.member_id,
      jsonb_build_object('draftId',d.id,'pickId',n.id));
  END IF;
END;
$$;
