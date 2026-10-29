CREATE OR REPLACE FUNCTION public.enqueue_rookie_pick_notification(p_draft_id uuid,p_member_id uuid,p_player_id uuid,p_pick_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' SET statement_timeout='3s' AS $$
BEGIN
  PERFORM private.enqueue_notifications(jsonb_build_array(jsonb_build_object(
    'dedupe_key','rookie-pick:'||p_pick_id::text||':'||p_member_id::text,
    'member_id',p_member_id,'event_type','rookie_draft_pick','title','Rookie Draft Pick Made',
    'body','A player has been added to your roster.',
    'data',jsonb_build_object('draftId',p_draft_id,'playerId',p_player_id,'pickId',p_pick_id),'category','draft')));
END;
$$;
