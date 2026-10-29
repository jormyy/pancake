BEGIN;
DO $$
DECLARE published text[];
BEGIN
  SELECT array_agg(schemaname||'.'||tablename ORDER BY schemaname,tablename) INTO published
  FROM pg_publication_tables WHERE pubname='supabase_realtime';
  IF published IS DISTINCT FROM ARRAY['public.draft_budgets','public.draft_picks','public.draft_room_members',
    'public.drafts','public.nominations','public.snake_draft_picks']::text[] THEN
    RAISE EXCEPTION 'Realtime must contain exactly the six draft tables: %',published;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime' AND pubinsert AND pubupdate AND pubdelete) THEN
    RAISE EXCEPTION 'Draft inserts, updates and deletes must remain published';
  END IF;
END;
$$;
ROLLBACK;
