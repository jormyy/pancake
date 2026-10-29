BEGIN;
DO $$
DECLARE published text[];
BEGIN
  SELECT array_agg(schemaname||'.'||tablename ORDER BY schemaname,tablename) INTO published
  FROM pg_publication_tables WHERE pubname='supabase_realtime';
  IF published IS DISTINCT FROM ARRAY[
    'public.draft_budgets',
    'public.draft_picks',
    'public.drafts',
    'public.league_change_hints',
    'public.league_members',
    'public.leagues',
    'public.matchup_forecasts',
    'public.nominations',
    'public.roster_players',
    'public.snake_draft_picks',
    'public.trade_block_items',
    'public.trade_items',
    'public.trade_participants',
    'public.trade_vetos',
    'public.trades',
    'public.waiver_claims']::text[] THEN
    RAISE EXCEPTION 'Realtime must contain exactly the client subscription tables: %',published;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime' AND pubinsert AND pubupdate AND pubdelete) THEN
    RAISE EXCEPTION 'Client inserts, updates and deletes must remain published';
  END IF;
END;
$$;
ROLLBACK;
