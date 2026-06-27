-- ============================================================
-- Performance: index unindexed foreign keys
--
-- The Supabase performance advisor flags single-column foreign keys with no
-- covering index: every FK-filtered query and every ON DELETE cascade seq-scans
-- the child table. Add covering indexes for the gameplay + audit FK columns.
--
-- Excluded: the two service-role-only internal bookkeeping tables
-- (trade_drop_reservations, backfill_game_attempts) — tiny and never client-
-- queried by these columns. Idempotent (IF NOT EXISTS); tables are small so a
-- plain (non-CONCURRENT) build is fine inside the migration transaction.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_roster_players_league_season_id ON public.roster_players(league_season_id);
CREATE INDEX IF NOT EXISTS idx_weekly_lineups_league_season_id ON public.weekly_lineups(league_season_id);
CREATE INDEX IF NOT EXISTS idx_weekly_lineups_player_id ON public.weekly_lineups(player_id);
CREATE INDEX IF NOT EXISTS idx_matchups_league_season_id ON public.matchups(league_season_id);
CREATE INDEX IF NOT EXISTS idx_matchups_winner_member_id ON public.matchups(winner_member_id);
CREATE INDEX IF NOT EXISTS idx_standings_league_season_id ON public.standings(league_season_id);
CREATE INDEX IF NOT EXISTS idx_rps_challenges_league_season_id ON public.rps_challenges(league_season_id);
CREATE INDEX IF NOT EXISTS idx_rps_challenges_member_b_id ON public.rps_challenges(member_b_id);
CREATE INDEX IF NOT EXISTS idx_rps_challenges_winner_member_id ON public.rps_challenges(winner_member_id);
CREATE INDEX IF NOT EXISTS idx_drafts_league_season_id ON public.drafts(league_season_id);
CREATE INDEX IF NOT EXISTS idx_draft_orders_member_id ON public.draft_orders(member_id);
CREATE INDEX IF NOT EXISTS idx_draft_budgets_member_id ON public.draft_budgets(member_id);
CREATE INDEX IF NOT EXISTS idx_nominations_current_bidder_id ON public.nominations(current_bidder_id);
CREATE INDEX IF NOT EXISTS idx_nominations_nominating_member_id ON public.nominations(nominating_member_id);
CREATE INDEX IF NOT EXISTS idx_nominations_winning_member_id ON public.nominations(winning_member_id);
CREATE INDEX IF NOT EXISTS idx_snake_draft_picks_member_id ON public.snake_draft_picks(member_id);
CREATE INDEX IF NOT EXISTS idx_snake_draft_picks_player_id ON public.snake_draft_picks(player_id);
CREATE INDEX IF NOT EXISTS idx_draft_picks_rookie_draft_id ON public.draft_picks(rookie_draft_id);
CREATE INDEX IF NOT EXISTS idx_waiver_priorities_league_season_id ON public.waiver_priorities(league_season_id);
CREATE INDEX IF NOT EXISTS idx_waiver_priorities_member_id ON public.waiver_priorities(member_id);
CREATE INDEX IF NOT EXISTS idx_waiver_claims_drop_player_id ON public.waiver_claims(drop_player_id);
CREATE INDEX IF NOT EXISTS idx_waiver_claims_league_season_id ON public.waiver_claims(league_season_id);
CREATE INDEX IF NOT EXISTS idx_waiver_wire_log_claimed_by_claim_id ON public.waiver_wire_log(claimed_by_claim_id);
CREATE INDEX IF NOT EXISTS idx_waiver_wire_log_dropped_by_member_id ON public.waiver_wire_log(dropped_by_member_id);
CREATE INDEX IF NOT EXISTS idx_waiver_wire_log_league_season_id ON public.waiver_wire_log(league_season_id);
CREATE INDEX IF NOT EXISTS idx_waiver_wire_log_player_id ON public.waiver_wire_log(player_id);
CREATE INDEX IF NOT EXISTS idx_trades_league_season_id ON public.trades(league_season_id);
CREATE INDEX IF NOT EXISTS idx_trade_vetos_member_id ON public.trade_vetos(member_id);
CREATE INDEX IF NOT EXISTS idx_roster_transactions_league_season_id ON public.roster_transactions(league_season_id);
CREATE INDEX IF NOT EXISTS idx_roster_transactions_related_claim_id ON public.roster_transactions(related_claim_id);
CREATE INDEX IF NOT EXISTS idx_roster_transactions_related_nomination_id ON public.roster_transactions(related_nomination_id);
CREATE INDEX IF NOT EXISTS idx_roster_transactions_related_trade_id ON public.roster_transactions(related_trade_id);
