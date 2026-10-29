CREATE OR REPLACE FUNCTION private.analyze_screen_table(p_relation text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
SET lock_timeout='100ms' SET statement_timeout='3s' SET maintenance_work_mem='16MB' AS $$
DECLARE target regclass:=to_regclass(p_relation);
BEGIN
  IF target IS NULL OR NOT target=ANY(private.screen_statistics_targets()) THEN
    RAISE EXCEPTION 'Unsupported statistics target' USING ERRCODE='22023';
  END IF;
  EXECUTE format('ANALYZE %s',target);
END;
$$;
