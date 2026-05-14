-- Ensure auction draft bid state is delivered through Supabase Realtime.
ALTER TABLE public.drafts REPLICA IDENTITY FULL;
ALTER TABLE public.draft_budgets REPLICA IDENTITY FULL;
ALTER TABLE public.nominations REPLICA IDENTITY FULL;
ALTER TABLE public.bids REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drafts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drafts;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'draft_budgets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.draft_budgets;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'nominations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.nominations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'bids'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bids;
  END IF;
END;
$$;
