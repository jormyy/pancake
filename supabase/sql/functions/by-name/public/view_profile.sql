-- Canonical SQL source for public.view_profile.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.view_profile(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; profile jsonb; preferences jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501'; END IF;
  IF p_league_id IS NOT NULL THEN context := public.view_context(p_league_id, p_member_id, p_params); END IF;
  SELECT jsonb_build_object('id', id, 'username', username, 'display_name', display_name,
    'avatar_url', avatar_url, 'created_at', created_at, 'updated_at', updated_at)
    INTO profile FROM public.profiles WHERE id = auth.uid();
  SELECT jsonb_build_object('tradeEnabled', trade_enabled, 'waiverEnabled', waiver_enabled,
    'draftEnabled', draft_enabled, 'activityEnabled', activity_enabled, 'masterEnabled', master_enabled,
    'categories', category_settings, 'events', event_settings) INTO preferences FROM public.notification_preferences WHERE user_id = auth.uid();
  RETURN jsonb_build_object('context', context, 'profile', profile, 'preferences', COALESCE(preferences,
    '{"tradeEnabled":true,"waiverEnabled":true,"draftEnabled":true,"activityEnabled":true,"masterEnabled":true,"categories":{},"events":{}}'::jsonb));
END;
$$;
