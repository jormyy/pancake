type Workload = { name: string; path: string; body?: Record<string, unknown>; minRows?: number }

export function readWorkloads(c: Record<string, string>): Workload[] {
  const league = `league_id=eq.${c.league}&league_season_id=eq.${c.season}`
  const member = `${league}&member_id=eq.${c.member}`
  const date = '2026-03-14'
  const table = (name: string, from: string, select: string, filters: string,minRows = 1): Workload => ({ name,minRows, path: `${from}?select=${encodeURIComponent(select)}&${filters}` })
  const rpc = (name: string, fn: string, body: Record<string, unknown>): Workload => ({ name, path: `rpc/${fn}`, body })
  return [
    table('home-matchup', 'matchups', 'id,home_points,away_points,winner_member_id,is_finalized,home_member_id,away_member_id', `${league}&week_number=eq.21`),
    table('home-roster', 'roster_players', 'id,player_id,is_on_ir,is_on_taxi,players(display_name,position,eligible_positions,nba_team,injury_status)', member),
    table('home-opponent', 'roster_players', 'id,player_id,is_on_ir,is_on_taxi,players(display_name,position,eligible_positions,nba_team,injury_status)', `${league}&member_id=eq.${c.opponent}`),
    table('home-games', 'nba_games', 'id,home_team,away_team,status,game_time', `game_date=eq.${date}`),
    table('home-lineups', 'weekly_lineups', 'player_id,slot_type', `${member}&game_date=eq.${date}`),
    table('home-live-stats','player_game_stats','player_id,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,personal_fouls,double_double,triple_double,minutes_played,did_not_play,nba_games!inner(nba_game_id)',`game_date=eq.${date}&player_id=in.(${c.roster})&nba_games.nba_game_id=like.002*`),
    table('roster-fantasy-averages','v_player_avg_fantasy_points','player_id,avg_fantasy_points',`league_id=eq.${c.league}&season_year=eq.2026&player_id=in.(${c.roster})`),
    table('roster-season-averages','mv_player_season_averages','player_id,avg_points,avg_rebounds,avg_assists,avg_steals,avg_blocks,avg_three_pointers_made,avg_turnovers,avg_minutes_played,games_played',`season_year=eq.2026&player_id=in.(${c.roster})`),
    table('player-fantasy-log','v_fantasy_points','stat_id,fantasy_points',`player_id=eq.${c.player}&league_id=eq.${c.league}&season_year=eq.2026`),
    table('player-dnp-check','player_game_stats','id',`player_id=eq.${c.player}&season_year=eq.2026&did_not_play=eq.true`,0),
    table('home-templates', 'lineup_slot_templates', 'slot_type,slot_count', `league_id=eq.${c.league}`),
    rpc('players-search-50', 'search_players', { p_query: '', p_position: 'ALL', p_teams: [], p_league_id: c.league, p_rookies_only: false, p_health: 'all', p_sort_by: 'fpts', p_sort_dir: 'desc', p_season_year: 2026, p_limit: 50, p_offset: 0 }),
    table('players-ownership', 'roster_players', 'player_id,member_id,league_members(team_name)', league),
    table('players-waivers', 'waiver_wire_log', 'player_id', `${league}&cleared_at=is.null`),
    table('players-rankings', 'dynasty_rankings', '*,player:players!dynasty_rankings_player_id_fkey(id,display_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id)', 'source=eq.hashtagbasketball.com&order=source_rank&limit=51'),
    table('players-news', 'dynasty_news', 'id,player_id,source,title,summary,url,published_at', 'order=published_at.desc&limit=30'),
    table('roster', 'roster_players', 'id,is_on_ir,is_on_taxi,acquired_via,players(id,display_name,nba_team,position,eligible_positions,injury_status,nba_id,nba_draft_number,years_exp)', `member_id=eq.${c.member}&league_season_id=eq.${c.season}&order=is_on_taxi,is_on_ir`),
    table('roster-picks', 'draft_picks', 'id,season_year,round,original_owner:league_members!draft_picks_original_owner_id_fkey(team_name)', `current_owner_id=eq.${c.member}&league_id=eq.${c.league}&is_used=eq.false&order=season_year,round`),
    table('roster-claims', 'waiver_claims', '*', `${member}&order=submitted_at.desc&limit=20`),
    rpc('roster-transaction-state', 'get_member_transaction_state', { p_member_id: c.member, p_league_id: c.league }),
    table('league-members', 'league_members', 'id,user_id,team_name,role', `league_id=eq.${c.league}&order=joined_at`),
    table('league-standings', 'standings', '*', `${league}&week_number=eq.20&order=wins.desc`),
    table('league-activity', 'league_activity', '*', `${league}&order=created_at.desc&limit=50`),
    table('league-picks', 'draft_picks', '*,original_owner:league_members!draft_picks_original_owner_id_fkey(team_name)', `league_id=eq.${c.league}&order=season_year,round`),
    table('league-matchups', 'matchups', '*', `${league}&order=week_number`),
    rpc('trades-page-refs', 'get_trade_page_refs', { p_member_id: c.member, p_league_id: c.league, p_limit: 41 }),
    table('trades-list', 'trades', 'id,status,proposed_at,accepted_at,veto_window_expires_at,proposer_member_id,recipient_member_id,trade_items(id,side,player_id,pick_id)', `league_id=eq.${c.league}&or=(proposer_member_id.eq.${c.member},recipient_member_id.eq.${c.member})&order=proposed_at.desc&limit=40`),
    rpc('dynasty-hub-inputs-600', 'get_dynasty_forecast_inputs', { p_league_id: c.league, p_member_id: c.member, p_season_year: 2026, p_query: '', p_limit: 600, p_offset: 0 }),
    rpc('trades-analyzer-inputs-15', 'get_dynasty_forecast_inputs', { p_league_id: c.league, p_member_id: c.member, p_season_year: 2026, p_player_ids: c.roster.split(','), p_query: '', p_limit: 15, p_offset: 0 }),
    table('player-detail', 'players', '*', `id=eq.${c.player}`),
    table('player-seasons', 'mv_player_season_averages', 'season_year', `player_id=eq.${c.player}&order=season_year.desc`),
    table('player-averages', 'mv_player_season_averages', '*', `player_id=eq.${c.player}&season_year=eq.2026`),
    table('player-game-log', 'player_game_stats', 'id,points,rebounds,assists,did_not_play,minutes_played,nba_games!inner(id,nba_game_id,game_date,home_team,away_team)', `player_id=eq.${c.player}&season_year=eq.2026&nba_games.nba_game_id=like.002*&order=game_date.desc&limit=16`),
    rpc('player-projection', 'get_league_projection_rows', { p_league_id: c.league, p_season_year: 2026, p_game_date: date, p_view: 'today', p_player_ids: [c.player], p_limit: 1, p_offset: 0 }),
    rpc('players-projections-600', 'get_league_projection_rows', { p_league_id: c.league, p_season_year: 2026, p_game_date: date, p_view: 'today', p_limit: 600, p_offset: 0 }),
    table('dynasty-roster-news', 'dynasty_news', '*', `player_id=in.(${c.roster})&order=published_at.desc&limit=30`),
    table('auction-draft', 'drafts', '*', `id=eq.${c.auction}`),
    table('auction-order', 'draft_orders', 'position,member_id,league_members(team_name)', `draft_id=eq.${c.auction}&order=position`),
    table('auction-budgets', 'draft_budgets', 'member_id,remaining,initial_budget,league_members(team_name)', `draft_id=eq.${c.auction}`),
    table('auction-nominations', 'nominations', '*,players(display_name,nba_team,position)', `draft_id=eq.${c.auction}&order=nomination_order`),
    table('rookie-draft', 'drafts', '*', `id=eq.${c.snake}`),
    table('rookie-pick-board', 'snake_draft_picks', '*', `draft_id=eq.${c.snake}&order=overall_pick`),
    table('rookie-player-board', 'players', 'id,display_name,nba_team,position,nba_draft_number', 'nba_draft_number=not.is.null&order=nba_draft_number&limit=100'),
  ]
}
