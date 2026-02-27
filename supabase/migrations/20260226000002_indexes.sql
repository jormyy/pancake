-- ============================================================
-- Migration 002: Indexes
-- Dynasty Fantasy Basketball App
-- ============================================================

-- profiles
CREATE INDEX idx_profiles_username ON profiles(username);

-- leagues
CREATE INDEX idx_leagues_commissioner ON leagues(commissioner_id);
CREATE INDEX idx_leagues_status ON leagues(status);

-- league_members
CREATE INDEX idx_league_members_user ON league_members(user_id);
CREATE INDEX idx_league_members_league ON league_members(league_id);

-- lineup_slot_templates
CREATE INDEX idx_slot_templates_league ON lineup_slot_templates(league_id);

-- players
CREATE INDEX idx_players_sportsdata_id ON players(sportsdata_id);
CREATE INDEX idx_players_display_name ON players(display_name);
CREATE INDEX idx_players_nba_team ON players(nba_team);
CREATE INDEX idx_players_position ON players(position);

-- roster_players
CREATE INDEX idx_roster_players_member ON roster_players(member_id);
CREATE INDEX idx_roster_players_league_season ON roster_players(league_id, league_season_id);
CREATE INDEX idx_roster_players_player ON roster_players(player_id);

-- weekly_lineups
CREATE INDEX idx_lineups_member_week ON weekly_lineups(member_id, league_season_id, week_number);
CREATE INDEX idx_lineups_league_week ON weekly_lineups(league_id, league_season_id, week_number);

-- nba_games
CREATE INDEX idx_nba_games_date ON nba_games(game_date);
CREATE INDEX idx_nba_games_season_week ON nba_games(season_year, week_number);

-- season_weeks
CREATE INDEX idx_season_weeks_year ON season_weeks(season_year);

-- player_game_stats
CREATE INDEX idx_pgs_player_week ON player_game_stats(player_id, week_number, season_year);
CREATE INDEX idx_pgs_game ON player_game_stats(game_id);
CREATE INDEX idx_pgs_season_week ON player_game_stats(season_year, week_number);

-- player_projections
CREATE INDEX idx_projections_player_week ON player_projections(player_id, season_year, week_number);

-- matchups
CREATE INDEX idx_matchups_league_season_week ON matchups(league_id, league_season_id, week_number);
CREATE INDEX idx_matchups_home ON matchups(home_member_id);
CREATE INDEX idx_matchups_away ON matchups(away_member_id);

-- standings
CREATE INDEX idx_standings_league_season_week ON standings(league_id, league_season_id, week_number);
CREATE INDEX idx_standings_member ON standings(member_id);

-- rps_challenges
CREATE INDEX idx_rps_league ON rps_challenges(league_id, league_season_id);
CREATE INDEX idx_rps_members ON rps_challenges(member_a_id, member_b_id);

-- drafts
CREATE INDEX idx_drafts_league ON drafts(league_id);
CREATE INDEX idx_drafts_status ON drafts(status);

-- nominations
CREATE INDEX idx_nominations_draft ON nominations(draft_id);
CREATE INDEX idx_nominations_draft_status ON nominations(draft_id, status);
CREATE INDEX idx_nominations_player ON nominations(player_id);

-- bids
CREATE INDEX idx_bids_nomination ON bids(nomination_id);
CREATE INDEX idx_bids_member ON bids(member_id);

-- snake_draft_picks
CREATE INDEX idx_snake_picks_draft ON snake_draft_picks(draft_id);
CREATE INDEX idx_snake_picks_member ON snake_draft_picks(draft_id, member_id);

-- draft_picks
CREATE INDEX idx_draft_picks_league_year ON draft_picks(league_id, season_year);
CREATE INDEX idx_draft_picks_current_owner ON draft_picks(current_owner_id);
CREATE INDEX idx_draft_picks_original_owner ON draft_picks(original_owner_id);

-- waiver_priorities
CREATE INDEX idx_waiver_priorities_league_season ON waiver_priorities(league_id, league_season_id);

-- waiver_claims
CREATE INDEX idx_waiver_claims_process_date ON waiver_claims(process_date, status);
CREATE INDEX idx_waiver_claims_member ON waiver_claims(member_id);
CREATE INDEX idx_waiver_claims_player ON waiver_claims(player_id);

-- waiver_wire_log
CREATE INDEX idx_waiver_log_league_player ON waiver_wire_log(league_id, player_id);
-- Partial index: only rows where player hasn't cleared yet (daily job query)
CREATE INDEX idx_waiver_log_pending_clear ON waiver_wire_log(clears_at)
  WHERE cleared_at IS NULL;

-- trades
CREATE INDEX idx_trades_league ON trades(league_id);
CREATE INDEX idx_trades_proposer ON trades(proposer_member_id);
CREATE INDEX idx_trades_recipient ON trades(recipient_member_id);
CREATE INDEX idx_trades_league_status ON trades(league_id, status);

-- trade_items
CREATE INDEX idx_trade_items_trade ON trade_items(trade_id);
CREATE INDEX idx_trade_items_player ON trade_items(player_id)
  WHERE player_id IS NOT NULL;
CREATE INDEX idx_trade_items_pick ON trade_items(pick_id)
  WHERE pick_id IS NOT NULL;

-- roster_transactions
CREATE INDEX idx_transactions_league_season ON roster_transactions(league_id, league_season_id);
CREATE INDEX idx_transactions_member ON roster_transactions(member_id);
CREATE INDEX idx_transactions_player ON roster_transactions(player_id);
CREATE INDEX idx_transactions_occurred_at ON roster_transactions(occurred_at DESC);
