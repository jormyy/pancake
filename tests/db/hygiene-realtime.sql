BEGIN;
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['weekly_lineups','waiver_claims','waiver_wire_log','league_seasons','bids'] LOOP
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
