BEGIN;
CREATE TEMP TABLE hint_budget_ids AS SELECT gen_random_uuid() AS owner_id,gen_random_uuid() AS league_id;
INSERT INTO auth.users(id,email) SELECT owner_id,owner_id::text||'@example.test' FROM hint_budget_ids;
INSERT INTO public.leagues(id,name,slug,commissioner_id)
  SELECT league_id,'Hint budget',league_id::text,owner_id FROM hint_budget_ids;
INSERT INTO public.league_members(league_id,user_id,role)
  SELECT league_id,owner_id,'commissioner' FROM hint_budget_ids;
INSERT INTO public.league_seasons(league_id,season_year,is_current)
  SELECT league_id,3999,true FROM hint_budget_ids;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO private.live_hint_broadcasts(transaction_id,topic,changes)
SELECT pg_current_xact_id(),'l1:league:'||league_id,jsonb_agg(jsonb_build_object('row',jsonb_build_object(
  'topic','inventory','scopes',NULL,'details',(SELECT jsonb_agg(jsonb_build_object('resource','season','season_id',md5(n::text||':'||value::text)::uuid))
    FROM generate_series(1,8) value),'revision',n)))
FROM hint_budget_ids CROSS JOIN generate_series(1,16) n GROUP BY league_id;
SELECT private.publish_league_version(league_id,ARRAY['inventory'],ARRAY['league_seasons']) FROM hint_budget_ids;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.league_change_hints h JOIN hint_budget_ids i USING(league_id)
    WHERE octet_length(h.details::text)>4096) THEN RAISE EXCEPTION 'Version hint exceeds transport budget'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.league_change_hints h JOIN hint_budget_ids i USING(league_id)
    WHERE h.topic='version' AND jsonb_array_length(h.details->0->'scope'->'hints')=0)
    THEN RAISE EXCEPTION 'Oversized version hint is not reduced'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.league_changes c JOIN hint_budget_ids i USING(league_id)
    WHERE jsonb_array_length(c.scope->'hints')>0) THEN RAISE EXCEPTION 'Durable change details are lost'; END IF;
END;
$$;
ROLLBACK;
