BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
ALTER PUBLICATION supabase_realtime SET TABLE
  public.drafts, public.draft_picks, public.draft_room_members,
  public.nominations, public.draft_budgets, public.snake_draft_picks;
COMMIT;
