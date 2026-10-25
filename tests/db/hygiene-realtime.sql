BEGIN;
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['weekly_lineups','waiver_claims','waiver_wire_log'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=target) THEN
      RAISE EXCEPTION 'Deployed client table % no longer publishes row changes',target;
    END IF;
    IF (SELECT relreplident FROM pg_class WHERE oid=format('public.%I',target)::regclass)<>'f' THEN
      RAISE EXCEPTION 'Deployed client table % lost full row identity',target;
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['league_seasons','bids'] LOOP
    IF EXISTS (SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=target) THEN
      RAISE EXCEPTION 'Unused table % still publishes row changes',target;
    END IF;
    IF (SELECT relreplident FROM pg_class WHERE oid=format('public.%I',target)::regclass)<>'d' THEN
      RAISE EXCEPTION 'Unused table % still logs full row identity',target;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='league_change_hints') THEN
    RAISE EXCEPTION 'League change subscriptions lose their published hints';
  END IF;
END $$;
ROLLBACK;
