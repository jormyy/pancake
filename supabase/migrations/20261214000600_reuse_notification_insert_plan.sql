BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE OR REPLACE FUNCTION private.notif_enqueue(p_event text, p_occurrence text, p_league_id uuid, p_member_id uuid, p_data jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,data,category)
  SELECT p_event || ':' || p_occurrence || ':' || member.id,member.id,p_event,event.label,
    COALESCE(p_data->>'body',event.label || '. Open Pancake for details.'),
    p_data || jsonb_build_object('leagueId',p_league_id,'notificationEvent',p_event),event.category
  FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id AND league.deleted_at IS NULL CROSS JOIN public.notif_event_catalog event
  WHERE member.id = p_member_id AND member.league_id = p_league_id AND event.event_type = p_event
  ON CONFLICT (dedupe_key) DO NOTHING;
END;
$$;
COMMIT;
