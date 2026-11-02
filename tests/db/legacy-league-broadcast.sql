BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='review-compatibility';
\ir rules-support.sql
DO $$
DECLARE f record; prior uuid[];
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9536);
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT array_agg(id) INTO prior FROM realtime.messages;
  UPDATE public.leagues SET name='Changed league settings' WHERE id=f.league_id;
  UPDATE public.league_members SET team_name='Updated member name' WHERE id=f.member_ids[2];
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM realtime.messages WHERE NOT id=ANY(COALESCE(prior,'{}'::uuid[]))
    AND topic='l1:league:'||f.league_id AND payload->>'table'='leagues' AND payload->>'eventType'='UPDATE'
    AND payload->>'schema'='public'),'loaded legacy clients receive direct league update events');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM realtime.messages WHERE NOT id=ANY(COALESCE(prior,'{}'::uuid[]))
    AND topic='l1:league:'||f.league_id AND payload->>'table'='league_members' AND payload->>'eventType'='UPDATE'),
    'loaded legacy league context still receives member updates');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
