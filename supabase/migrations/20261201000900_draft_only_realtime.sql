BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';
ALTER PUBLICATION supabase_realtime SET TABLE
  public.draft_budgets,
  public.draft_picks,
  public.drafts,
  public.league_change_hints,
  public.league_members,
  public.leagues,
  public.matchup_forecasts,
  public.nominations,
  public.roster_players,
  public.snake_draft_picks,
  public.trade_block_items,
  public.trade_items,
  public.trade_participants,
  public.trade_vetos,
  public.trades,
  public.waiver_claims;
COMMIT;
