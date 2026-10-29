\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
SET LOCAL statement_timeout='30s';
TRUNCATE public.public_read_log;
INSERT INTO public.public_read_log(league_id,hour,resource,reads)
SELECT member.league_id,date_trunc('hour',now())-interval '8 days'-sequence.number*interval '1 hour','league',1
FROM (SELECT league_id FROM public.league_members ORDER BY id LIMIT 1) member
CROSS JOIN generate_series(1,12001) sequence(number);
DO $$
DECLARE removed integer;
BEGIN
  removed:=public.public_prune_read_log();
  IF removed<>5000 OR (SELECT count(*) FROM public.public_read_log)<>7001 THEN
    RAISE EXCEPTION 'Public read retention exceeds its batch limit';
  END IF;
  IF NOT EXISTS(SELECT FROM private.retention_rules WHERE relation_name='public.public_read_log' AND worker='retain_public_read_log') THEN
    RAISE EXCEPTION 'Public read retention is not scheduled';
  END IF;
  IF EXISTS(SELECT FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    LEFT JOIN private.retention_rules rule ON rule.relation_name=namespace.nspname||'.'||relation.relname
    WHERE relation.relkind IN ('r','p','m') AND namespace.nspname IN ('public','private','analytics')
      AND rule.relation_name IS NULL) THEN
    RAISE EXCEPTION 'A database relation has no retention policy';
  END IF;
END;
$$;
ROLLBACK;
