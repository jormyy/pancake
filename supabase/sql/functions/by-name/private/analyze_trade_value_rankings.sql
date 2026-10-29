CREATE OR REPLACE FUNCTION private.analyze_trade_value_rankings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT FROM published_rankings WHERE source='onenumberhoops.com') THEN
    ANALYZE public.dynasty_rankings;
  END IF;
  RETURN NULL;
END;
$$;
