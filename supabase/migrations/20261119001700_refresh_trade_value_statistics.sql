SET lock_timeout='3s';
SET statement_timeout='30s';
CREATE OR REPLACE FUNCTION private.analyze_trade_value_rankings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT FROM published_rankings WHERE source='onenumberhoops.com') THEN
    ANALYZE public.dynasty_rankings;
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION private.analyze_trade_value_rankings() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.analyze_trade_value_rankings() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS trade_rankings_analyze_insert ON public.dynasty_rankings;
CREATE TRIGGER trade_rankings_analyze_insert AFTER INSERT ON public.dynasty_rankings
REFERENCING NEW TABLE AS published_rankings FOR EACH STATEMENT EXECUTE FUNCTION private.analyze_trade_value_rankings();
DROP TRIGGER IF EXISTS trade_rankings_analyze_update ON public.dynasty_rankings;
CREATE TRIGGER trade_rankings_analyze_update AFTER UPDATE ON public.dynasty_rankings
REFERENCING NEW TABLE AS published_rankings FOR EACH STATEMENT EXECUTE FUNCTION private.analyze_trade_value_rankings();
DROP TRIGGER IF EXISTS trade_rankings_analyze_delete ON public.dynasty_rankings;
CREATE TRIGGER trade_rankings_analyze_delete AFTER DELETE ON public.dynasty_rankings
REFERENCING OLD TABLE AS published_rankings FOR EACH STATEMENT EXECUTE FUNCTION private.analyze_trade_value_rankings();
ANALYZE public.dynasty_rankings;
