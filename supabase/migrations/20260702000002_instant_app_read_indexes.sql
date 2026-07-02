-- Additive indexes for first-paint app reads. These match the most repeated
-- tab queries so cached UI refreshes complete quickly after the screen renders.

CREATE INDEX IF NOT EXISTS idx_weekly_lineups_member_date_read
  ON public.weekly_lineups (league_id, league_season_id, member_id, game_date)
  INCLUDE (player_id, slot_type);

CREATE INDEX IF NOT EXISTS idx_roster_players_member_season_read
  ON public.roster_players (member_id, league_id, league_season_id)
  INCLUDE (player_id, is_on_ir, is_on_taxi);

CREATE INDEX IF NOT EXISTS idx_waiver_wire_active_league_season_clear
  ON public.waiver_wire_log (league_id, league_season_id, clears_at)
  INCLUDE (player_id)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_waiver_claims_member_season_active
  ON public.waiver_claims (member_id, league_season_id, status, claim_order, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_draft_picks_member_league_available
  ON public.draft_picks (league_id, current_owner_id, season_year, round)
  INCLUDE (original_owner_id)
  WHERE is_used = false;

CREATE INDEX IF NOT EXISTS idx_trades_league_proposer_recent
  ON public.trades (league_id, proposer_member_id, proposed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_league_recipient_recent
  ON public.trades (league_id, recipient_member_id, proposed_at DESC);

CREATE INDEX IF NOT EXISTS idx_trades_vetoable_recent
  ON public.trades (league_id, accepted_at DESC)
  WHERE status = 'accepted' AND veto_window_expires_at IS NOT NULL;
