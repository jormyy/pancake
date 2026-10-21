CREATE OR REPLACE FUNCTION private.notif_draft_clock(p_draft_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.drafts%ROWTYPE;
  p public.snake_draft_picks%ROWTYPE;
  n public.snake_draft_picks%ROWTYPE;
  seats int;
  nominator uuid;
  next_nominator uuid;
  resets int;
BEGIN
  SELECT * INTO d FROM public.drafts WHERE id = p_draft_id;
  IF d.status <> 'in_progress' OR d.is_mock THEN RETURN; END IF;
  IF d.draft_type = 'auction' THEN
    SELECT count(*) INTO seats FROM public.draft_orders WHERE draft_id = d.id;
    IF seats = 0 OR EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = d.id AND status = 'open') THEN RETURN; END IF;
    SELECT member_id INTO nominator FROM public.draft_orders
      WHERE draft_id = d.id AND position = ((d.current_nomination_order - 1) % seats) + 1;
    SELECT member_id INTO next_nominator FROM public.draft_orders
      WHERE draft_id = d.id AND position = (d.current_nomination_order % seats) + 1;
    -- A reset restarts the order on the same draft, so turns are keyed per reset.
    SELECT count(*) INTO resets FROM public.draft_audit_logs WHERE draft_id = d.id AND action = 'reset';
    PERFORM private.notif_enqueue('draft_on_clock',d.id::text || ':nomination:' || resets || ':' || d.current_nomination_order,d.league_id,nominator,
      jsonb_build_object('draftId',d.id,'resets',resets,'nominationOrder',d.current_nomination_order,'body','You are on the clock to nominate a player.'));
    IF next_nominator IS DISTINCT FROM nominator THEN
      PERFORM private.notif_enqueue('draft_coming_soon',d.id::text || ':nomination:' || resets || ':' || (d.current_nomination_order + 1),d.league_id,next_nominator,
        jsonb_build_object('draftId',d.id,'resets',resets,'nominationOrder',d.current_nomination_order + 1));
    END IF;
    RETURN;
  END IF;
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
