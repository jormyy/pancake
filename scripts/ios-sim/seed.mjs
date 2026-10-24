import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { json, localUrl, project, readJson, run } from './common.mjs'

export async function seed({ stack, snapshot, directory }) {
  localUrl(stack.url)
  const stackProject = stack.project ?? project
  assert.match(stackProject, /^[a-zA-Z0-9_-]+$/)
  const complete = await readJson(path.join(directory, 'complete.json'))
  if (complete?.rosterPlanTrade) return complete
  const { createClient } = createRequire(path.join(snapshot, 'package.json'))('@supabase/supabase-js')
  const admin = createClient(stack.url, stack.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  if (complete) {
    const rosterPlanTrade = await seedRosterPlanTrade(admin, { leagueId: complete.leagueId, seasonId: complete.seasonId, members: complete.members, players: complete.players })
    const upgraded = { ...complete, rosterPlanTrade }
    await json(path.join(directory, 'complete.json'), upgraded)
    return upgraded
  }
  await mkdir(path.join(directory, 'tests'), { recursive: true })
  let state = await readJson(path.join(directory, 'tests/e2e-state.json'))
  if (!state) {
    await run(process.execPath, [path.join(snapshot, 'tests/e2e/seed-league.mjs')], {
      cwd: directory,
      env: { ...process.env, E2E_SEED_RUN_ID: 'iossim2027', E2E_SUPABASE_URL: stack.url, E2E_SUPABASE_PUBLISHABLE_KEY: stack.anonKey, E2E_PANCAKE_SUPABASE_SECRET_KEY: stack.serviceKey },
    })
    state = await readJson(path.join(directory, 'tests/e2e-state.json'))
  }
  const db = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(`iOS seed: ${error.message}`)
    return data
  }
  const members = await db(admin.from('league_members').select('id,user_id,team_name').eq('league_id', state.leagueId))
  members.sort((a, b) => state.users.findIndex(user => user.id === a.user_id) - state.users.findIndex(user => user.id === b.user_id))
  const season = await db(admin.from('league_seasons').select('id,season_year').eq('league_id', state.leagueId).eq('is_current', true).single())
  await db(admin.from('league_seasons').update({ season_year: 2027 }).eq('id', season.id))
  await db(admin.from('leagues').update({ name: 'iPhone Dynasty 2027', status: 'active', roster_size: 20, ir_slots: 2, taxi_slots: 3 }).eq('id', state.leagueId))
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const date = offset => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
  const monday = weekday === 0 ? -6 : 1 - weekday
  await db(admin.from('season_weeks').upsert(Array.from({ length: 26 }, (_, index) => ({ season_year: 2027, week_number: index + 1, week_start: date(monday + index * 7), week_end: date(monday + index * 7 + 6) })), { onConflict: 'season_year,week_number' }))
  const firstNames = ['Jalen', 'Marcus', 'Devin', 'Isaiah', 'Anthony', 'Tyrese', 'Cameron', 'Jordan', 'Keegan', 'Malik']
  const lastNames = ['Brooks', 'Carter', 'Williams', 'Johnson', 'Davis', 'Thomas', 'Murray', 'Walker', 'Reed', 'Mitchell']
  const teams = ['BOS', 'NYK', 'DEN', 'LAL', 'GSW', 'DAL', 'MIA', 'CHI', 'ATL', 'CLE']
  const slots = ['PG', 'SG', 'SF', 'PF', 'C']
  await db(admin.from('players').upsert(Array.from({ length: 260 }, (_, index) => ({
    sportsdata_id: `ios-sim-${String(index + 1).padStart(3, '0')}`, nba_id: `IOS${index + 1}`, sleeper_id: `ios-${index + 1}`,
    first_name: firstNames[index % 10], last_name: `${lastNames[Math.floor(index / 10) % 10]} ${index + 1}`,
    nba_team: teams[index % 10], position: slots[index % 22 % 5], eligible_positions: [slots[index % 22 % 5], index % 22 % 5 < 2 ? 'G' : 'F'],
    status: 'Active', injury_status: index % 22 === 20 || index >= 240 ? 'Out' : null,
    years_exp: index % 22 === 21 ? 0 : 4, nba_draft_number: index % 22 === 21 ? Math.floor(index / 22) + 1 : null,
  })), { onConflict: 'sportsdata_id' }))
  const players = await db(admin.from('players').select('id,display_name,position,nba_team,sleeper_id,sportsdata_id').like('sportsdata_id', 'ios-sim-%').order('sportsdata_id'))
  const drafts = await db(admin.from('drafts').select('id,draft_type').eq('league_id', state.leagueId))
  const rookieDraft = drafts.find(draft => draft.draft_type === 'snake')
  const uuid = value => { assert.match(value, /^[a-f0-9-]{36}$/); return `'${value}'` }
  const sql = statement => run('docker', ['exec', `supabase_db_${stackProject}`, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '--set', 'ON_ERROR_STOP=1', '-c', statement])
  for (const [memberIndex, member] of members.entries()) {
    const assigned = players.slice(memberIndex * 22, memberIndex * 22 + 22)
    const existing = await db(admin.from('roster_players').select('player_id').eq('member_id', member.id).eq('league_season_id', season.id))
    const used = new Set(existing.map(row => row.player_id))
    const rows = assigned.slice(0, 21).filter(player => !used.has(player.id)).map((player, index) => ({ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, player_id: player.id, acquired_via: 'draft', acquisition_cost: index + 1, is_on_ir: player.id === assigned[20].id }))
    if (rows.length) await db(admin.from('roster_players').insert(rows))
    if (!used.has(assigned[21].id)) await sql(`BEGIN; SELECT private.authorize_taxi_acquisition(${uuid(state.leagueId)},${uuid(season.id)},${uuid(member.id)},${uuid(assigned[21].id)},'draft',${uuid(rookieDraft.id)}); INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi) VALUES (${uuid(state.leagueId)},${uuid(season.id)},${uuid(member.id)},${uuid(assigned[21].id)},'draft',true); COMMIT;`)
    const lineupSlots = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'UTIL', 'F', 'UTIL', 'UTIL']
    const existingLineups = await db(admin.from('weekly_lineups').select('id').eq('member_id', member.id).eq('game_date', today))
    if (!existingLineups.length) await db(admin.from('weekly_lineups').insert(assigned.slice(0, 10).map((player, index) => ({ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, player_id: player.id, week_number: 1, game_date: today, slot_type: lineupSlots[index] }))))
  }
  const gameRows = [
    { nba_game_id: '0022609001', game_date: date(-1), season_year: 2027, week_number: 1, home_team: 'BOS', away_team: 'NYK', status: 'Final', home_score: 114, away_score: 107 },
    { nba_game_id: '0022609002', game_date: today, season_year: 2027, week_number: 1, home_team: 'DEN', away_team: 'LAL', status: 'InProgress', game_time: new Date(Date.now() - 3600000).toISOString(), home_score: 64, away_score: 61 },
    { nba_game_id: '0022609003', game_date: today, season_year: 2027, week_number: 1, home_team: 'GSW', away_team: 'DAL', status: 'Scheduled', home_score: 0, away_score: 0, game_time: new Date(Date.now() + 7200000).toISOString() },
    { nba_game_id: '0022509001', game_date: '2025-11-01', season_year: 2026, week_number: 1, home_team: 'BOS', away_team: 'NYK', status: 'Final', home_score: 104, away_score: 102 },
    ...Array.from({ length: 4 }, (_, index) => ({ nba_game_id: `002260900${index + 4}`, game_date: date(-1), season_year: 2027, week_number: 1, home_team: teams[index * 2 + 2], away_team: teams[index * 2 + 3], status: 'Final', home_score: 110 + index, away_score: 103 + index })),
    ...Array.from({ length: 4 }, (_, index) => ({ nba_game_id: `002250900${index + 2}`, game_date: '2025-11-01', season_year: 2026, week_number: 1, home_team: teams[index * 2 + 2], away_team: teams[index * 2 + 3], status: 'Final', home_score: 108 + index, away_score: 101 + index })),
  ]
  const games = await db(admin.from('nba_games').upsert(gameRows, { onConflict: 'nba_game_id' }).select('id,nba_game_id,game_date,season_year,status,home_team,away_team'))
  let gameLines = 0
  for (const game of games.filter(game => game.status !== 'Scheduled')) {
    const rows = players.filter(player => [game.home_team, game.away_team].includes(player.nba_team)).map((player, index) => ({ game_id: game.id, game_date: game.game_date, season_year: game.season_year, week_number: 1, player_id: player.id, minutes_played: game.status === 'Final' ? 32 : 17, points: 2 * (4 + index % 8) + 5, rebounds: 3 + index % 9, assists: 2 + index % 8, steals: index % 3, blocks: index % 2, turnovers: index % 4, field_goals_made: 4 + index % 8, field_goals_attempted: 15, three_pointers_made: 2, three_pointers_attempted: 5, free_throws_made: 3, free_throws_attempted: 4, did_not_play: false }))
    await db(admin.from('player_game_stats').upsert(rows, { onConflict: 'player_id,game_id' }))
    gameLines += rows.length
  }
  const projections = games.filter(game => game.game_date === today).flatMap(game => players.filter(player => [game.home_team, game.away_team].includes(player.nba_team)).map(player => ({ player_id: player.id, sleeper_id: player.sleeper_id, season_year: 2027, week_number: 1, game_date: today, source_game_id: `ios-${game.nba_game_id}`, team: player.nba_team, opponent: player.nba_team === game.home_team ? game.away_team : game.home_team, last_modified: Date.now(), minutes: 32, points: 20, rebounds: 6, assists: 5, steals: 1, blocks: 1, turnovers: 2, field_goals_made: 7, field_goals_attempted: 15, three_pointers_made: 3, three_pointers_attempted: 7, free_throws_made: 3, free_throws_attempted: 4 })))
  await db(admin.from('sleeper_projection_rows').upsert(projections, { onConflict: 'player_id,source_game_id' }))
  await db(admin.from('dynasty_rankings').upsert(players.map((player, index) => ({ source: 'hashtagbasketball.com', source_rank: index + 1, source_player_id: player.sleeper_id, source_player_name: player.display_name, source_positions: [player.position], source_team: player.nba_team, scoring_format: 'overall', player_id: player.id })), { onConflict: 'source,source_rank' }))
  await db(admin.from('matchups').delete().eq('league_id', state.leagueId).eq('week_number', 1))
  await db(admin.from('matchups').insert(Array.from({ length: 5 }, (_, index) => ({ league_id: state.leagueId, league_season_id: season.id, week_number: 1, home_member_id: members[index * 2].id, away_member_id: members[index * 2 + 1].id, home_points: 180 + index * 9, away_points: 172 + index * 11 }))))
  const wire = await db(admin.from('waiver_wire_log').select('id').eq('league_id', state.leagueId).limit(1))
  if (!wire.length) await db(admin.from('waiver_wire_log').insert(players.slice(230, 240).map(player => ({ league_id: state.leagueId, league_season_id: season.id, player_id: player.id, dropped_by_member_id: members[1].id, clears_at: new Date(Date.now() + 86400000).toISOString() }))))
  const transactions = await db(admin.from('roster_transactions').select('id').eq('league_id', state.leagueId).limit(1))
  if (!transactions.length) await db(admin.from('roster_transactions').insert(members.flatMap((member, index) => players.slice(index * 22, index * 22 + 4).map(player => ({ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, player_id: player.id, transaction_type: 'fa_add', occurred_at: new Date(Date.now() - 86400000).toISOString() })))))
  const trades = await db(admin.from('trades').select('id').eq('league_id', state.leagueId).limit(1))
  if (!trades.length) for (let index = 0; index < 10; index += 2) await db(admin.rpc('propose_trade_atomic', { p_league_id: state.leagueId, p_league_season_id: season.id, p_proposer_member_id: members[index].id, p_recipient_member_id: members[index + 1].id, p_offer_player_ids: [players[index * 22].id], p_request_player_ids: [players[(index + 1) * 22].id], p_offer_pick_ids: [], p_request_pick_ids: [] }))
  const rosterPlanTrade = await seedRosterPlanTrade(admin, { leagueId: state.leagueId, seasonId: season.id, members, players })
  await db(admin.rpc('refresh_player_search_caches'))
  const result = { ...state, members, rosterPlanTrade, seasonId: season.id, seasonYear: 2027, today, players, drafts, counts: { teams: 10, players: 340, rostered: 220, games: games.length, gameLines, projections: projections.length } }
  await json(path.join(directory, 'complete.json'), result)
  return result
}

export async function seedRosterPlanTrade(admin, { leagueId, seasonId, members, players }) {
  const db = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(`iOS roster-plan seed: ${error.message}`)
    return data
  }
  await db(admin.from('leagues').update({ allow_inactive_trades: true }).eq('id', leagueId))
  const notes = 'iPhone roster-plan fixture: choose a drop and receive the rookie into taxi.'
  const existing = await db(admin.from('trades').select('id').eq('league_id', leagueId).eq('league_season_id', seasonId).eq('notes', notes).eq('status', 'pending').maybeSingle())
  const manager = 1
  const rookiePlayerId = players[21].id
  const id = existing?.id ?? await db(admin.rpc('propose_trade_atomic', {
    p_league_id: leagueId, p_league_season_id: seasonId,
    p_proposer_member_id: members[0].id, p_recipient_member_id: members[manager].id,
    p_offer_player_ids: [players[18].id, players[19].id, rookiePlayerId],
    p_request_player_ids: [players[manager * 22 + 19].id],
    p_offer_pick_ids: [], p_request_pick_ids: [], p_notes: notes,
  }))
  return { id, manager, rookiePlayerId, dropPlayerId: players[manager * 22 + 18].id }
}
