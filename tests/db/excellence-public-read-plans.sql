\set ON_ERROR_STOP on
BEGIN;
\ir excellence-fixture.sql
SET LOCAL statement_timeout='30s';
TRUNCATE public.public_read_log;
INSERT INTO public.public_read_log(league_id,hour,resource,reads)
SELECT member.league_id,date_trunc('hour',now())-interval '8 days'-sequence.number*interval '1 hour','league',1
FROM (SELECT league_id FROM public.league_members ORDER BY id LIMIT 1) member
CROSS JOIN generate_series(1,12001) sequence(number);
INSERT INTO public.public_read_log(league_id,hour,resource,reads)
SELECT league_id,date_trunc('hour',now()),'league',1 FROM public.league_members ORDER BY id LIMIT 1;
CREATE FUNCTION pg_temp.drain_public_reads() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE removed integer; total integer:=0;
BEGIN
  FOR iteration IN 1..5 LOOP
    removed:=public.public_prune_read_log();
    total:=total+removed;
    EXIT WHEN removed=0;
  END LOOP;
  IF total<>12001 OR (SELECT count(*) FROM public.public_read_log)<>1 THEN
    RAISE EXCEPTION 'Public read retention loses current counters';
  END IF;
  RETURN total;
END;
$$;
EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) SELECT pg_temp.drain_public_reads();
SELECT md5(jsonb_agg(to_jsonb(row))::text) FROM public.public_read_log row;
ROLLBACK;
