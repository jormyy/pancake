-- Ensure matchup score updates are delivered through Supabase Realtime.
ALTER TABLE public.matchups REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'matchups'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.matchups;
  END IF;
END;
$$;
