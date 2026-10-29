CREATE OR REPLACE FUNCTION private.publish_asset_lock_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed jsonb; previous jsonb; league_id uuid; prior_mode text; topic text;
BEGIN
  changed := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  previous := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  IF TG_OP='UPDATE' AND changed=previous THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME IN ('trades','waiver_claims') THEN
    IF COALESCE(changed->>'status','') NOT IN ('pending','accepted')
      AND COALESCE(previous->>'status','') NOT IN ('pending','accepted') THEN RETURN NULL; END IF;
    league_id := (changed->>'league_id')::uuid;
  ELSE
    SELECT trade.league_id INTO league_id FROM public.trades trade WHERE trade.id=(changed->>'trade_id')::uuid
      AND trade.status IN ('pending','accepted');
  END IF;
  IF league_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=league_id) THEN RETURN NULL; END IF;
  topic := CASE WHEN TG_TABLE_NAME='waiver_claims' THEN 'claim' ELSE 'trade' END;
  prior_mode := COALESCE(current_setting('pancake.trade_write',true),'');
  PERFORM set_config('pancake.trade_write','',true);
  PERFORM private.league_version_enqueue(league_id,topic,'locked_assets');
  PERFORM set_config('pancake.trade_write',prior_mode,true);
  RETURN NULL;
END;
$$;
