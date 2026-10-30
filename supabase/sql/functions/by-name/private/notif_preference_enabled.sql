-- Canonical SQL source for private.notif_preference_enabled.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
  RETURN COALESCE((p.event_settings->>p_event)::boolean,e.default_enabled,
    p_event IN ('rookie_draft_pick','waiver_claim_succeeded','waiver_claim_failed'));
END;
$$;
