ALTER PUBLICATION supabase_realtime DROP TABLE
  public.weekly_lineups,
  public.waiver_claims,
  public.waiver_wire_log,
  public.league_seasons,
  public.bids;

ALTER TABLE public.weekly_lineups REPLICA IDENTITY DEFAULT;
ALTER TABLE public.waiver_claims REPLICA IDENTITY DEFAULT;
ALTER TABLE public.waiver_wire_log REPLICA IDENTITY DEFAULT;
ALTER TABLE public.league_seasons REPLICA IDENTITY DEFAULT;
ALTER TABLE public.bids REPLICA IDENTITY DEFAULT;

DROP POLICY IF EXISTS leagues_update ON public.leagues;
DROP POLICY IF EXISTS slot_templates_delete ON public.lineup_slot_templates;
DROP POLICY IF EXISTS slot_templates_insert ON public.lineup_slot_templates;
DROP POLICY IF EXISTS slot_templates_update ON public.lineup_slot_templates;
DROP POLICY IF EXISTS rps_insert ON public.rps_challenges;
DROP POLICY IF EXISTS rps_update ON public.rps_challenges;
DROP POLICY IF EXISTS trade_block_items_delete_own ON public.trade_block_items;
DROP POLICY IF EXISTS trade_block_items_insert_own ON public.trade_block_items;
DROP POLICY IF EXISTS trade_block_items_update_own ON public.trade_block_items;
DROP POLICY IF EXISTS trade_items_insert ON public.trade_items;
DROP POLICY IF EXISTS trade_vetos_insert ON public.trade_vetos;
DROP POLICY IF EXISTS trades_insert ON public.trades;
DROP POLICY IF EXISTS trades_update ON public.trades;

DROP INDEX IF EXISTS public.idx_projections_player_week;
DROP INDEX IF EXISTS public.idx_players_sportsdata_id;
DROP INDEX IF EXISTS public.idx_profiles_username;
DROP INDEX IF EXISTS public.idx_leagues_invite_code;
DROP INDEX IF EXISTS public.idx_weekly_add_counts_member_week;
