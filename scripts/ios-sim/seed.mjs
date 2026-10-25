import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { json, localUrl, project, readJson, run } from './common.mjs'

function easternDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function requireCurrentSeed(fixture) {
  assert.equal(fixture.today, easternDate(), 'The fixture date differs from today in Eastern time; run start --reset after other captures stop')
}

export async function seed({ stack, snapshot, directory }) {
  localUrl(stack.url)
  const stackProject = stack.project ?? project
  assert.match(stackProject, /^[a-zA-Z0-9_-]+$/)
  const complete = await readJson(path.join(directory, 'complete.json'))
  if (complete) requireCurrentSeed(complete)
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
  const today = easternDate()
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

export async function withAuctionNomination(admin, { draftId, memberId, playerId }, action) {
  const db = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(`iOS auction fixture: ${error.message}`)
    return data
  }
  const nominations = await db(admin.from('nominations').select('id,status,countdown_expires_at,nomination_order').eq('draft_id', draftId))
  assert.ok(!nominations.some(row => row.status === 'open'), 'Auction fixture requires an idle nomination slot')
  const nomination = await db(admin.from('nominations').insert({
    draft_id: draftId, nominating_member_id: memberId, player_id: playerId,
    nomination_order: Math.max(0, ...nominations.map(row => row.nomination_order)) + 1,
    current_bid_amount: 1, current_bidder_id: memberId,
    countdown_expires_at: new Date(Date.now() + 3600000).toISOString(),
  }).select('id').single())
  try { return await action() }
  finally { await db(admin.from('nominations').delete().eq('id', nomination.id)) }
}

export async function withHealthyIRPlayer(admin, { memberId, seasonId }, action) {
  const db = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(`iOS IR fixture: ${error.message}`)
    return data
  }
  const roster = await db(admin.from('roster_players').select('player_id').eq('member_id', memberId).eq('league_season_id', seasonId).eq('is_on_ir', true))
  assert.ok(roster.length, 'The capture manager needs a player on IR')
  const players = await db(admin.from('players').select('id,injury_status').in('id', roster.map(row => row.player_id)))
  assert.equal(players.length, roster.length, 'An IR player is missing')
  try {
    await db(admin.from('players').update({ injury_status: null }).in('id', players.map(player => player.id)))
    return await action()
  } finally {
    for (const player of players) await db(admin.from('players').update({ injury_status: player.injury_status }).eq('id', player.id))
  }
}

export async function withDraftRoom(admin, { draftId, draftType, leagueId, seasonId, members }, action) {
  assert.ok(['auction', 'snake'].includes(draftType), 'Unknown capture draft type')
  const db = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(`iOS draft fixture: ${error.message}`)
    return data
  }
  await db(admin.from('drafts').insert({
    id: draftId, league_id: leagueId, league_season_id: seasonId, draft_type: draftType,
    status: 'in_progress', is_mock: true, budget_per_team: draftType === 'auction' ? 200 : null,
    started_at: new Date().toISOString(), pick_timer_seconds: 3600, rounds: 3,
    created_by_member_id: members[0].id,
  }))
  try {
    await db(admin.from('draft_room_members').insert(members.map(member => ({ draft_id: draftId, member_id: member.id }))))
    await db(admin.from('draft_orders').insert(members.map((member, index) => ({ draft_id: draftId, member_id: member.id, position: index + 1 }))))
    if (draftType === 'auction') {
      await db(admin.from('draft_budgets').insert(members.map(member => ({ draft_id: draftId, member_id: member.id, initial_budget: 200, remaining: 200 }))))
    } else {
      await db(admin.from('snake_draft_picks').insert(Array.from({ length: 3 }, (_, roundIndex) => {
        const order = roundIndex % 2 ? [...members].reverse() : members
        return order.map((member, index) => ({ draft_id: draftId, overall_pick: roundIndex * members.length + index + 1, round: roundIndex + 1, pick_in_round: index + 1, member_id: member.id }))
      }).flat()))
    }
    return await action()
  } finally {
    await db(admin.from('drafts').delete().eq('id', draftId))
  }
}

export async function withScenarioFixtures(stack, scenarios, action) {
  const types = [...new Set(scenarios.map(scenario => scenario.setup?.draftRoom).filter(Boolean))]
  if (!types.length) return action({})
  localUrl(stack.url)
  const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js')
  const admin = createClient(stack.url, stack.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const createRoom = async (index, drafts) => {
    if (index === types.length) return action(drafts)
    const draftType = types[index]
    const draftId = randomUUID()
    return withDraftRoom(admin, {
      draftId, draftType, leagueId: stack.fixture.leagueId, seasonId: stack.fixture.seasonId, members: stack.fixture.members,
    }, () => createRoom(index + 1, { ...drafts, [draftType]: draftId }))
  }
  return createRoom(0, {})
}

async function captureData(operation) {
  const { data, error } = await operation
  if (error) throw new Error(`iOS capture fixture: ${error.message}`)
  return data
}

export async function withOutPlayer(admin, playerId, action) {
  const player = await captureData(admin.from('players').select('injury_status').eq('id', playerId).single())
  try {
    await captureData(admin.from('players').update({ injury_status: 'Out' }).eq('id', playerId))
    return await action()
  } finally {
    await captureData(admin.from('players').update({ injury_status: player.injury_status }).eq('id', playerId))
  }
}

export async function withWaiverIRPlayer(admin, { leagueId, seasonId, playerId }, action) {
  const logs = await captureData(admin.from('waiver_wire_log').select('id,clears_at')
    .eq('league_id', leagueId).eq('league_season_id', seasonId).eq('player_id', playerId).is('cleared_at', null))
  const previous = logs[0]
  let created
  return withOutPlayer(admin, playerId, async () => {
    try {
      const clears_at = new Date(Date.now() + 86400000).toISOString()
      if (previous) await captureData(admin.from('waiver_wire_log').update({ clears_at }).eq('id', previous.id))
      else created = await captureData(admin.from('waiver_wire_log').insert({
        league_id: leagueId, league_season_id: seasonId, player_id: playerId, clears_at,
      }).select('id').single())
      return await action()
    } finally {
      if (previous) await captureData(admin.from('waiver_wire_log').update({ clears_at: previous.clears_at }).eq('id', previous.id))
      if (created) await captureData(admin.from('waiver_wire_log').delete().eq('id', created.id))
    }
  })
}

export async function withWeekOffLeague(admin, { memberId, seasonYear, today, name }, action) {
  const member = await captureData(admin.from('league_members').select('user_id,team_name').eq('id', memberId).single())
  const week = await captureData(admin.from('season_weeks').select('week_number').eq('season_year', seasonYear)
    .lte('week_start', today).gte('week_end', today).single())
  const leagueId = randomUUID()
  await captureData(admin.from('leagues').insert({
    id: leagueId, name, slug: leagueId, commissioner_id: member.user_id, status: 'active',
  }))
  try {
    await captureData(admin.from('league_seasons').insert({
      id: randomUUID(), league_id: leagueId, season_year: seasonYear, is_current: true, skipped_weeks: [week.week_number],
    }))
    await captureData(admin.from('league_members').insert({
      id: randomUUID(), league_id: leagueId, user_id: member.user_id, role: 'commissioner', team_name: member.team_name,
    }))
    return await action()
  } finally {
    await captureData(admin.from('leagues').delete().eq('id', leagueId))
  }
}

export async function withScenarioSetup(stack, setup, action) {
  if (!setup) return action()
  localUrl(stack.url)
  const { createClient } = createRequire(import.meta.url)('@supabase/supabase-js')
  const admin = createClient(stack.url, stack.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  if (setup.taxiMember) return withTaxiCapture(admin, { fixture: stack.fixture, memberId: setup.taxiMember, mode: setup.taxiMode, stackProject: stack.project ?? project }, action)
  if (setup.rosterLimit) return withLeagueSettings(admin, stack.fixture.leagueId, { roster_size: setup.rosterLimit }, action)
  if (setup.activationMember) return withActivationLineup(admin, stack.fixture, setup.activationMember, action)
  if (setup.tradePlan) return withTradePlanPlayer(admin, stack.fixture.players[18].id, action)
  if (setup.freeAgentIRMember) return withFreeAgentCapture(admin, { leagueId: stack.fixture.leagueId,
    seasonId: stack.fixture.seasonId, memberId: setup.freeAgentIRMember, playerId: setup.freeAgentIRPlayer }, action)
  if (setup.waiverClaimMember) return withWaiverClaimCapture(admin, { leagueId: stack.fixture.leagueId,
    seasonId: stack.fixture.seasonId, memberId: setup.waiverClaimMember, playerId: setup.waiverPlayer }, action)
  if (setup.waiverAwardMember) return withWaiverAward(admin, stack.fixture, setup.waiverAwardMember, setup.waiverPlayer, action)
  if (setup.liveAuctionLeader) return withAuctionNomination(admin, {
    draftId: stack.fixture.drafts.find(draft => draft.draft_type === 'auction').id,
    memberId: setup.liveAuctionLeader, playerId: stack.fixture.players[220].id,
  }, action)
  if (setup.waiverIRPlayer || setup.irShortcutPlayer) {
    const playerId = setup.waiverIRPlayer ?? setup.irShortcutPlayer
    assert.ok(stack.fixture.players.some(player => player.id === playerId), 'Unknown IR capture player')
    return setup.waiverIRPlayer
      ? withWaiverIRPlayer(admin, { leagueId: stack.fixture.leagueId, seasonId: stack.fixture.seasonId, playerId }, action)
      : withOutPlayer(admin, playerId, action)
  }
  if (setup.weekOffMember) {
    assert.ok(stack.fixture.members.some(member => member.id === setup.weekOffMember), 'Unknown week-off capture manager')
    return withWeekOffLeague(admin, {
      memberId: setup.weekOffMember, seasonYear: stack.fixture.seasonYear, today: stack.fixture.today, name: setup.weekOffName,
    }, action)
  }
  if (setup.healthyIRMember) {
    assert.ok(stack.fixture.members.some(member => member.id === setup.healthyIRMember), 'Unknown IR capture manager')
    return withHealthyIRPlayer(admin, { memberId: setup.healthyIRMember, seasonId: stack.fixture.seasonId }, action)
  }
  if (setup.draftRoom) {
    if (!setup.auctionNomination) return action()
    return withAuctionNomination(admin, {
      draftId: setup.draftId, memberId: stack.fixture.members[0].id, playerId: stack.fixture.players[220].id,
    }, action)
  }
  assert.fail('Unknown scenario setup')
}

export async function withLeagueSettings(admin, leagueId, settings, action) {
  const previous = await captureData(admin.from('leagues').select(Object.keys(settings).join(',')).eq('id', leagueId).single())
  try {
    await captureData(admin.from('leagues').update(settings).eq('id', leagueId))
    return await action()
  } finally { await captureData(admin.from('leagues').update(previous).eq('id', leagueId)) }
}

async function withActivationLineup(admin, fixture, memberId, action) {
  const index = fixture.members.findIndex(member => member.id === memberId)
  assert.ok(index >= 0, 'Unknown activation manager')
  const offset = (7 - new Date(`${fixture.today}T12:00:00Z`).getUTCDay()) % 7
  const date = new Date(Date.parse(`${fixture.today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
  const previous = await captureData(admin.from('weekly_lineups').select('*').eq('member_id', memberId).eq('game_date', date))
  const clear = () => captureData(admin.from('weekly_lineups').delete().eq('member_id', memberId).eq('game_date', date))
  try {
    await clear()
    const slots = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'UTIL', 'F', 'UTIL', 'UTIL']
    await captureData(admin.from('weekly_lineups').insert(fixture.players.slice(index * 22, index * 22 + 10).flatMap((player, position) => position === 1 ? [] : [{
      league_id: fixture.leagueId, league_season_id: fixture.seasonId, member_id: memberId,
      player_id: player.id, game_date: date, week_number: 1, slot_type: slots[position],
    }])))
    return await action()
  } finally {
    await clear()
    if (previous.length) await captureData(admin.from('weekly_lineups').insert(previous))
  }
}

async function withWaiverClaimCapture(admin, { leagueId, seasonId, memberId, playerId }, action) {
  const read = () => captureData(admin.from('waiver_claims').select('id').eq('member_id', memberId).eq('league_season_id', seasonId).eq('player_id', playerId))
  const previous = new Set((await read()).map(row => row.id))
  return withAddCounts(admin, { leagueId, seasonId, memberId }, () => withWaiverIRPlayer(admin, { leagueId, seasonId, playerId }, async () => {
    try { return await action() }
    finally {
      for (const row of await read()) if (!previous.has(row.id)) await captureData(admin.from('waiver_claims').delete().eq('id', row.id))
    }
  }))
}

export async function withWaiverAward(admin, fixture, memberId, playerId, action) {
  const index = fixture.members.findIndex(member => member.id === memberId)
  assert.ok(index >= 0, 'Unknown waiver award manager')
  const dropped = await captureData(admin.from('roster_players').select('*').eq('member_id', memberId)
    .eq('league_season_id', fixture.seasonId).eq('player_id', fixture.players[index * 22 + 10].id).single())
  const player = await captureData(admin.from('players').select('injury_status').eq('id', playerId).single())
  let award
  try {
    await captureData(admin.from('roster_players').delete().eq('id', dropped.id))
    await captureData(admin.from('players').update({ injury_status: null }).eq('id', playerId))
    award = await captureData(admin.from('roster_players').insert({ league_id: fixture.leagueId,
      league_season_id: fixture.seasonId, member_id: memberId, player_id: playerId, acquired_via: 'waiver',
      is_on_ir: false, is_on_taxi: false }).select('id').single())
    return await action()
  } finally {
    if (award) await captureData(admin.from('roster_players').delete().eq('id', award.id))
    await captureData(admin.from('players').update(player).eq('id', playerId))
    await captureData(admin.from('roster_players').insert(dropped))
  }
}

async function withTradePlanPlayer(admin, playerId, action) {
  const previous = await captureData(admin.from('players').select('years_exp,nba_draft_number').eq('id', playerId).single())
  try {
    await captureData(admin.from('players').update({ years_exp: 0, nba_draft_number: 19 }).eq('id', playerId))
    return await action()
  } finally { await captureData(admin.from('players').update(previous).eq('id', playerId)) }
}

async function withAddCounts(admin, { leagueId, seasonId, memberId }, action) {
  const scope = query => query.eq('league_id', leagueId).eq('league_season_id', seasonId).eq('member_id', memberId)
  const previous = await captureData(scope(admin.from('weekly_add_counts').select('*')))
  try { return await action() }
  finally {
    await captureData(scope(admin.from('weekly_add_counts').delete()))
    if (previous.length) await captureData(admin.from('weekly_add_counts').insert(previous))
  }
}

export async function withFreeAgentCapture(admin, { leagueId, seasonId, memberId, playerId }, action) {
  const read = table => captureData(admin.from(table).select('id').eq('league_id', leagueId)
    .eq('league_season_id', seasonId).eq('member_id', memberId).eq('player_id', playerId))
  const previous = Object.fromEntries(await Promise.all(['roster_players', 'roster_transactions'].map(async table => [table, new Set((await read(table)).map(row => row.id))])))
  assert.equal(previous.roster_players.size, 0, 'The IR capture target must start as a free agent')
  return withAddCounts(admin, { leagueId, seasonId, memberId }, () => withOutPlayer(admin, playerId, async () => {
    try { return await action() }
    finally {
      for (const table of ['roster_players', 'roster_transactions']) {
        for (const row of await read(table)) if (!previous[table].has(row.id)) await captureData(admin.from(table).delete().eq('id', row.id))
      }
    }
  }))
}

export async function withTaxiCapture(admin, { fixture, memberId, mode, stackProject = project, execute = run }, action) {
  assert.ok(['tags', 'open', 'full', 'claim', 'illegal-taxi', 'illegal-ir', 'trade-taxi', 'trade-ir'].includes(mode), 'Unknown taxi capture mode')
  const index = fixture.members.findIndex(member => member.id === memberId)
  assert.ok(index >= 0, 'Unknown taxi capture manager')
  assert.match(stackProject, /^[a-zA-Z0-9_-]+$/)
  const { leagueId, seasonId } = fixture
  const target = fixture.players[220 + index]
  const waiver = fixture.players[230 + index]
  const veteran = fixture.players[240 + index]
  const scope = query => query.eq('league_id', leagueId).eq('league_season_id', seasonId).eq('member_id', memberId)
  const read = table => captureData(scope(admin.from(table).select('*')))
  const roster = await read('roster_players')
  const taxi = roster.filter(row => row.is_on_taxi)
  const ir = roster.filter(row => row.is_on_ir)
  assert.ok(taxi.length && ir.length, 'Taxi captures need existing taxi and IR players')
  assert.ok(!roster.some(row => [target.id, waiver.id, veteran.id].includes(row.player_id)), 'Taxi capture targets must be unrostered')
  const ids = [...new Set([target.id, waiver.id, veteran.id, ...taxi.map(row => row.player_id), ...ir.map(row => row.player_id)])]
  const players = await captureData(admin.from('players').select('id,years_exp,career_regular_season_games,injury_status').in('id', ids))
  assert.equal(players.length, ids.length, 'A taxi capture player is missing')
  const tables = ['roster_players', 'roster_transactions', 'waiver_claims', 'weekly_add_counts']
  const before = Object.fromEntries(await Promise.all(tables.map(async table => [table, await read(table)])))
  const activityScope = query => query.eq('league_id', leagueId).eq('league_season_id', seasonId).eq('actor_member_id', memberId)
  const activity = await captureData(activityScope(admin.from('league_activity').select('id')))
  const trades = await captureData(admin.from('trades').select('id').eq('league_id', leagueId).eq('league_season_id', seasonId).eq('proposer_member_id', memberId))
  const logs = await captureData(admin.from('waiver_wire_log').select('id,clears_at').eq('league_id', leagueId).eq('league_season_id', seasonId).eq('player_id', waiver.id).is('cleared_at', null))
  const exits = await captureData(admin.from('league_member_taxi_exits').select('player_id').eq('league_id', leagueId).eq('member_id', memberId).in('player_id', [target.id, waiver.id]))
  assert.equal(exits.length, 0, 'Taxi capture targets must have no taxi exit')
  const drafts = mode.startsWith('trade-') ? await captureData(admin.from('drafts').select('id,is_mock').eq('league_id', leagueId).eq('league_season_id', seasonId).eq('draft_type', 'auction').eq('is_mock', false)) : []
  let createdLog
  const uuid = value => { assert.match(value, /^[a-f0-9-]{36}$/); return `'${value}'` }
  const sql = statement => execute('docker', ['exec', `supabase_db_${stackProject}`, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '--set', 'ON_ERROR_STOP=1', '-c', statement])
  const clean = async () => {
    for (const row of await read('roster_players')) {
      if (before.roster_players.some(previous => previous.id === row.id)) continue
      assert.equal(row.player_id, target.id, 'Unexpected taxi capture acquisition')
      await sql(`BEGIN; DELETE FROM private.taxi_acquisition_context WHERE transaction_id::text=(SELECT xmin::text FROM roster_players WHERE id=${uuid(row.id)}) AND league_id=${uuid(leagueId)} AND league_season_id=${uuid(seasonId)} AND member_id=${uuid(memberId)} AND player_id=${uuid(target.id)} AND source='free_agent'; SELECT private.authorize_taxi_acquisition(${uuid(leagueId)},${uuid(seasonId)},${uuid(memberId)},${uuid(target.id)},'draft_reset',${uuid(target.id)}); DELETE FROM roster_players WHERE id=${uuid(row.id)} AND member_id=${uuid(memberId)} AND league_season_id=${uuid(seasonId)}; DELETE FROM private.taxi_acquisition_context WHERE transaction_id=pg_current_xact_id() AND member_id=${uuid(memberId)} AND player_id=${uuid(target.id)}; COMMIT;`)
    }
    for (const table of ['roster_transactions', 'waiver_claims']) {
      for (const row of await read(table)) if (!before[table].some(previous => previous.id === row.id)) await captureData(admin.from(table).delete().eq('id', row.id))
    }
    for (const row of await captureData(activityScope(admin.from('league_activity').select('id')))) {
      if (!activity.some(previous => previous.id === row.id)) await sql(`DELETE FROM league_activity WHERE id=${uuid(row.id)} AND actor_member_id=${uuid(memberId)};`)
    }
    for (const row of await captureData(admin.from('trades').select('id').eq('league_id', leagueId).eq('league_season_id', seasonId).eq('proposer_member_id', memberId))) {
      if (!trades.some(previous => previous.id === row.id)) await captureData(admin.from('trades').delete().eq('id', row.id))
    }
  }
  const active = roster.filter(row => !row.is_on_ir && !row.is_on_taxi).length
  return withLeagueSettings(admin, leagueId, {
    roster_size: active + (mode === 'open' ? 1 : 0), taxi_slots: taxi.length + 1, weekly_add_limit: null,
    ...(mode.startsWith('trade-') ? { trade_deadline: null } : {}),
  }, async () => {
    try {
      for (const draft of drafts) await captureData(admin.from('drafts').update({ is_mock: true }).eq('id', draft.id))
      for (const player of players) {
        const settings = player.id === veteran.id ? { years_exp: 4, career_regular_season_games: 65 }
          : player.id === waiver.id ? { years_exp: 2, career_regular_season_games: 64 }
            : { years_exp: 0, career_regular_season_games: 0 }
        if (taxi.some(row => row.player_id === player.id) && ['illegal-taxi', 'trade-taxi'].includes(mode)) Object.assign(settings, { years_exp: 4, career_regular_season_games: 65 })
        const injury_status = ir.some(row => row.player_id === player.id) && !['illegal-ir', 'trade-ir'].includes(mode) ? 'Out' : null
        await captureData(admin.from('players').update({ ...settings, injury_status }).eq('id', player.id))
      }
      if (mode === 'claim') {
        const clears_at = new Date(Date.now() + 86400000).toISOString()
        if (logs.length) for (const log of logs) await captureData(admin.from('waiver_wire_log').update({ clears_at }).eq('id', log.id))
        else createdLog = await captureData(admin.from('waiver_wire_log').insert({ league_id: leagueId, league_season_id: seasonId, player_id: waiver.id, clears_at }).select('id').single())
      }
      const result = await action()
      if (mode === 'open') {
        const current = await read('roster_players')
        assert.deepEqual(current.filter(row => roster.some(previous => previous.id === row.id)), roster, 'Add to taxi must preserve existing roster players')
        const added = current.filter(row => !roster.some(previous => previous.id === row.id))
        assert.equal(added.length, 1, 'Add to taxi must acquire exactly one player')
        assert.equal(added[0].player_id, target.id)
        assert.equal(added[0].is_on_taxi, true, 'Add to taxi must use a taxi slot')
        assert.equal(added[0].is_on_ir, false)
      } else {
        for (const table of tables) assert.deepEqual(await read(table), before[table], `Blocked or preview action changed ${table}`)
        assert.deepEqual(await captureData(admin.from('trades').select('id').eq('league_id', leagueId).eq('league_season_id', seasonId).eq('proposer_member_id', memberId)), trades, 'Blocked trade created an offer')
      }
      return result
    } finally {
      const restored = await Promise.allSettled([
        clean(),
        ...drafts.map(draft => captureData(admin.from('drafts').update({ is_mock: draft.is_mock }).eq('id', draft.id))),
        ...players.map(({ id, ...previous }) => captureData(admin.from('players').update(previous).eq('id', id))),
        ...logs.map(log => captureData(admin.from('waiver_wire_log').update({ clears_at: log.clears_at }).eq('id', log.id))),
        ...(createdLog ? [captureData(admin.from('waiver_wire_log').delete().eq('id', createdLog.id))] : []),
        (async () => {
          await captureData(scope(admin.from('weekly_add_counts').delete()))
          if (before.weekly_add_counts.length) await captureData(admin.from('weekly_add_counts').insert(before.weekly_add_counts))
        })(),
      ])
      const failed = restored.filter(result => result.status === 'rejected')
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Taxi fixture cleanup failed')
    }
  })
}
