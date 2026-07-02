-- Secondary first-paint read indexes for routes that still refresh in the
-- background after cached UI hydration.

CREATE INDEX IF NOT EXISTS idx_matchups_playoff_bracket_instant
  ON public.matchups (league_id, league_season_id, matchup_type, week_number)
  INCLUDE (home_member_id, away_member_id, home_points, away_points, winner_member_id, is_finalized)
  WHERE matchup_type IN (
    'playoff_quarterfinal'::public.matchup_type,
    'playoff_semifinal'::public.matchup_type,
    'playoff_final'::public.matchup_type
  );

CREATE INDEX IF NOT EXISTS idx_roster_transactions_player_league_recent
  ON public.roster_transactions (player_id, league_id, occurred_at DESC)
  INCLUDE (transaction_type, member_id);

CREATE INDEX IF NOT EXISTS idx_drafts_active_joinable_instant
  ON public.drafts (league_id, created_at DESC)
  INCLUDE (
    id,
    league_season_id,
    status,
    draft_type,
    current_nomination_order,
    nomination_order_mode,
    budget_per_team,
    scheduled_at,
    room_name,
    created_by_member_id,
    pick_timer_seconds,
    timer_expiry_behavior,
    rounds,
    started_at,
    pause_reason,
    paused_at,
    timer_paused_remaining_seconds
  )
  WHERE is_mock = false
    AND status IN (
      'pending'::public.draft_status,
      'in_progress'::public.draft_status,
      'paused'::public.draft_status
    );

CREATE INDEX IF NOT EXISTS idx_drafts_completed_rookie_join_instant
  ON public.drafts (league_id, created_at DESC)
  INCLUDE (
    id,
    league_season_id,
    current_nomination_order,
    nomination_order_mode,
    budget_per_team,
    scheduled_at,
    room_name,
    created_by_member_id,
    pick_timer_seconds,
    timer_expiry_behavior,
    rounds,
    started_at,
    pause_reason,
    paused_at,
    timer_paused_remaining_seconds
  )
  WHERE is_mock = false
    AND draft_type = 'snake'::public.draft_type
    AND status = 'completed'::public.draft_status;

CREATE INDEX IF NOT EXISTS idx_nominations_draft_order_instant
  ON public.nominations (draft_id, nomination_order)
  INCLUDE (
    id,
    status,
    current_bid_amount,
    current_bidder_id,
    countdown_expires_at,
    winning_member_id,
    final_price,
    nominating_member_id,
    nominated_at,
    player_id
  );

CREATE INDEX IF NOT EXISTS idx_players_rookie_board_instant
  ON public.players (years_exp, nba_draft_number, id)
  INCLUDE (display_name, nba_team, "position")
  WHERE nba_draft_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dynasty_rankings_player_age_recent
  ON public.dynasty_rankings (player_id, fetched_at DESC)
  INCLUDE (age)
  WHERE player_id IS NOT NULL
    AND age IS NOT NULL;
