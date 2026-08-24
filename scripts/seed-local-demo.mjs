import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { currentSeasonYear } from '@pancake/core'

const DEMO_SLUG = 'pancake-local-demo'
const DEMO_PASSWORD = 'PancakeDemo1!'
const DEMO_SEASON_YEAR = currentSeasonYear()
const DEMO_WEEK = 1

const managers = [
  { email: 'demo@pancake.test', username: 'demo_manager', displayName: 'Demo Manager', teamName: 'Maple City' },
  { email: 'rival@pancake.test', username: 'demo_rival', displayName: 'Rival Manager', teamName: 'Sunday Buckets' },
  { email: 'north@pancake.test', username: 'demo_north', displayName: 'North Manager', teamName: 'Northern Lights' },
  { email: 'coast@pancake.test', username: 'demo_coast', displayName: 'Coast Manager', teamName: 'Coast to Coast' },
]

const firstNames = [
  'Adrian', 'Andre', 'Caleb', 'Cameron', 'Darius', 'Devin', 'Elias', 'Isaiah',
  'Jalen', 'Jordan', 'Kendall', 'Malik', 'Marcus', 'Miles', 'Noah', 'Xavier',
]
const lastNames = ['Archer', 'Banks', 'Cole', 'Daniels']
const teams = ['ATL', 'BOS', 'BKN', 'CHI', 'DAL', 'DEN', 'GSW', 'LAL']
const positionCycle = ['PG', 'SG', 'SF', 'PF', 'C', 'PG', 'SF', 'SG', 'PF', 'C', 'G', 'F', 'PG', 'SG', 'SF', 'C']
const starterSlots = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'UTIL', 'UTIL']

function commandJson(command, args) {
  return JSON.parse(execFileSync(command, args, { encoding: 'utf8' }))
}

function localStatus() {
  const status = commandJson('supabase', ['status', '-o', 'json'])
  const url = status.API_URL
  if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('Refusing to seed a non-local Supabase project.')
  }
  if (!status.SECRET_KEY || !status.PUBLISHABLE_KEY) {
    throw new Error('Local Supabase did not return its API keys.')
  }
  return { url, secretKey: status.SECRET_KEY, publishableKey: status.PUBLISHABLE_KEY }
}

function etDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + amount)
  return value.toISOString().slice(0, 10)
}

function currentWeek() {
  const today = etDate()
  const value = new Date(`${today}T12:00:00Z`)
  const day = value.getUTCDay()
  const start = addDays(today, day === 0 ? -6 : 1 - day)
  return { today, start, end: addDays(start, 6), dates: Array.from({ length: 7 }, (_, index) => addDays(start, index)) }
}

function eligiblePositions(position) {
  if (position === 'PG') return ['PG', 'G']
  if (position === 'SG') return ['SG', 'G']
  if (position === 'SF') return ['SF', 'F']
  if (position === 'PF') return ['PF', 'F']
  if (position === 'G') return ['PG', 'SG', 'G']
  if (position === 'F') return ['SF', 'PF', 'F']
  return ['C']
}

function demoPlayers() {
  return managers.flatMap((_, managerIndex) => positionCycle.map((position, rosterIndex) => {
    const index = managerIndex * positionCycle.length + rosterIndex
    return {
      sportsdata_id: `local-demo-player-${String(index + 1).padStart(3, '0')}`,
      espn_id: `local-demo-espn-${String(index + 1).padStart(3, '0')}`,
      first_name: firstNames[rosterIndex],
      last_name: lastNames[managerIndex],
      nba_team: teams[index % teams.length],
      position,
      eligible_positions: eligiblePositions(position),
      jersey_number: String((index * 3) % 55),
      status: 'Active',
      injury_status: null,
      years_exp: 1 + (index % 8),
      dynasty_rank: index + 1,
      dynasty_rank_source: 'local-demo',
      dynasty_rank_fetched_at: new Date().toISOString(),
    }
  }))
}

function assertNoError(label, result) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

async function removePreviousDemo(admin) {
  const league = assertNoError('find prior demo league', await admin
    .from('leagues')
    .select('id')
    .eq('slug', DEMO_SLUG)
    .maybeSingle())
  if (league) assertNoError('delete prior demo league', await admin.from('leagues').delete().eq('id', league.id))

  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const emails = new Set(managers.map((manager) => manager.email))
  for (const user of data.users.filter((candidate) => candidate.email && emails.has(candidate.email))) {
    assertNoError(`delete prior demo user ${user.email}`, await admin.auth.admin.deleteUser(user.id))
  }

  const demoGames = assertNoError('find prior demo games', await admin
    .from('nba_games')
    .select('id')
    .like('sportsdata_game_id', 'local-demo-%'))
  const demoGameIds = demoGames.map((game) => game.id)
  if (demoGameIds.length > 0) {
    assertNoError('delete prior demo box scores', await admin
      .from('player_game_stats')
      .delete()
      .in('game_id', demoGameIds))
    assertNoError('delete prior demo games', await admin
      .from('nba_games')
      .delete()
      .in('id', demoGameIds))
  }
}

async function createManagers(admin, env) {
  const created = []
  for (const manager of managers) {
    const result = await admin.auth.admin.createUser({
      email: manager.email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { username: manager.username, display_name: manager.displayName },
    })
    const user = assertNoError(`create ${manager.email}`, result).user
    created.push({ ...manager, id: user.id })
  }
  assertNoError('upsert demo profiles', await admin.from('profiles').upsert(created.map((manager) => ({
    id: manager.id,
    username: manager.username,
    display_name: manager.displayName,
  })), { onConflict: 'id' }))

  const clients = []
  for (const manager of created) {
    const client = createClient(env.url, env.publishableKey, { auth: { persistSession: false } })
    assertNoError(`sign in ${manager.email}`, await client.auth.signInWithPassword({
      email: manager.email,
      password: DEMO_PASSWORD,
    }))
    clients.push(client)
  }
  return { created, clients }
}

async function createLeague(admin, created, clients, week) {
  const league = assertNoError('create demo league', await clients[0].rpc('create_league', {
    p_name: 'Pancake Local Demo',
    p_team_name: created[0].teamName,
    p_auction_budget: 200,
  }))

  for (let index = 1; index < created.length; index += 1) {
    assertNoError(`join ${created[index].email}`, await clients[index].rpc('join_league_by_invite_code', {
      p_invite_code: league.invite_code,
      p_team_name: created[index].teamName,
    }))
  }

  assertNoError('configure demo league', await admin.from('leagues').update({
    name: 'Pancake Local Demo',
    slug: DEMO_SLUG,
    status: 'active',
    roster_size: positionCycle.length,
    taxi_slots: 2,
    scoring_settings: {
      points: 1,
      rebounds: 1.2,
      assists: 1.5,
      steals: 3,
      blocks: 3,
      turnovers: -1,
      three_pointers_made: 0.5,
    },
  }).eq('id', league.id))
  assertNoError('set bench size', await admin.from('lineup_slot_templates').update({ slot_count: 6 })
    .eq('league_id', league.id).eq('slot_type', 'BE'))

  const season = assertNoError('load demo season', await admin.from('league_seasons')
    .select('id')
    .eq('league_id', league.id)
    .eq('is_current', true)
    .single())
  assertNoError('configure demo season', await admin.from('league_seasons').update({
    season_year: DEMO_SEASON_YEAR,
    regular_season_start: week.start,
    regular_season_end: addDays(week.end, 140),
  }).eq('id', season.id))
  assertNoError('seed current demo week', await admin.from('season_weeks').upsert({
    season_year: DEMO_SEASON_YEAR,
    week_number: DEMO_WEEK,
    week_start: week.start,
    week_end: week.end,
  }, { onConflict: 'season_year,week_number' }))

  const members = assertNoError('load demo members', await admin.from('league_members')
    .select('id,user_id,team_name')
    .eq('league_id', league.id))
  members.sort((a, b) => created.findIndex((manager) => manager.id === a.user_id) - created.findIndex((manager) => manager.id === b.user_id))
  return { league, season: { ...season, season_year: DEMO_SEASON_YEAR }, members }
}

async function seedBasketball(admin, fixture, week) {
  const players = assertNoError('seed demo players', await admin.from('players')
    .upsert(demoPlayers(), { onConflict: 'sportsdata_id' })
    .select('id,sportsdata_id,nba_team'))
  players.sort((a, b) => a.sportsdata_id.localeCompare(b.sportsdata_id))

  const rosters = fixture.members.flatMap((member, managerIndex) => {
    const memberPlayers = players.slice(managerIndex * positionCycle.length, (managerIndex + 1) * positionCycle.length)
    return memberPlayers.map((player) => ({
      league_id: fixture.league.id,
      league_season_id: fixture.season.id,
      member_id: member.id,
      player_id: player.id,
      acquired_via: 'local_demo_draft',
      acquisition_cost: 1 + ((managerIndex + player.sportsdata_id.length) % 35),
    }))
  })
  assertNoError('seed demo rosters', await admin.from('roster_players').insert(rosters))
  assertNoError('seed roster history', await admin.from('roster_transactions').insert(rosters.map((row) => ({
    league_id: row.league_id,
    league_season_id: row.league_season_id,
    member_id: row.member_id,
    player_id: row.player_id,
    transaction_type: 'draft_won',
    occurred_at: `${week.start}T16:00:00Z`,
  }))))

  assertNoError('seed demo matchups', await admin.from('matchups').insert([
    {
      league_id: fixture.league.id, league_season_id: fixture.season.id, week_number: DEMO_WEEK,
      home_member_id: fixture.members[0].id, away_member_id: fixture.members[1].id,
      home_points: 462.3, away_points: 438.7,
    },
    {
      league_id: fixture.league.id, league_season_id: fixture.season.id, week_number: DEMO_WEEK,
      home_member_id: fixture.members[2].id, away_member_id: fixture.members[3].id,
      home_points: 411.8, away_points: 405.2,
    },
  ]))

  const lineupRows = []
  for (let managerIndex = 0; managerIndex < fixture.members.length; managerIndex += 1) {
    const memberPlayers = players.slice(managerIndex * positionCycle.length, (managerIndex + 1) * positionCycle.length)
    for (const date of week.dates) {
      starterSlots.forEach((slotType, index) => lineupRows.push({
        league_id: fixture.league.id,
        league_season_id: fixture.season.id,
        member_id: fixture.members[managerIndex].id,
        player_id: memberPlayers[index].id,
        week_number: DEMO_WEEK,
        game_date: date,
        slot_type: slotType,
        is_auto_set: false,
      }))
    }
  }
  assertNoError('seed daily lineups', await admin.from('weekly_lineups').insert(lineupRows))

  const games = []
  for (const date of week.dates) {
    for (let index = 0; index < teams.length; index += 2) {
      const past = date < week.today
      const gameKey = `${date}-${index / 2 + 1}`
      games.push({
        sportsdata_game_id: `local-demo-${gameKey}`,
        nba_game_id: `002local-demo-${gameKey}`,
        season_year: DEMO_SEASON_YEAR,
        game_date: date,
        week_number: DEMO_WEEK,
        home_team: teams[index],
        away_team: teams[index + 1],
        status: past ? 'Final' : 'Scheduled',
        game_status_text: past ? 'Final' : '7:30 PM ET',
        game_time: past ? `${date}T23:30:00Z` : `${date}T23:30:00Z`,
        home_score: past ? 112 + index : 0,
        away_score: past ? 105 + index : 0,
      })
    }
  }
  const insertedGames = assertNoError('seed demo schedule', await admin.from('nba_games').upsert(games, {
    onConflict: 'sportsdata_game_id',
  }).select('id,game_date,home_team,away_team'))

  const finishedGames = insertedGames.filter((game) => game.game_date < week.today)
  const stats = players.flatMap((player, playerIndex) => finishedGames
    .filter((game) => game.home_team === player.nba_team || game.away_team === player.nba_team)
    .map((game, gameIndex) => ({
      player_id: player.id,
      game_id: game.id,
      game_date: game.game_date,
      season_year: DEMO_SEASON_YEAR,
      week_number: DEMO_WEEK,
      minutes_played: 27 + ((playerIndex + gameIndex) % 12),
      points: 14 + ((playerIndex * 3 + gameIndex) % 22),
      rebounds: 3 + ((playerIndex + gameIndex) % 10),
      assists: 2 + ((playerIndex * 2 + gameIndex) % 9),
      steals: (playerIndex + gameIndex) % 3,
      blocks: (playerIndex + gameIndex) % 2,
      turnovers: 1 + ((playerIndex + gameIndex) % 4),
      three_pointers_made: (playerIndex + gameIndex) % 5,
      field_goals_made: 6 + ((playerIndex + gameIndex) % 8),
      field_goals_attempted: 13 + ((playerIndex + gameIndex) % 9),
      free_throws_made: 2 + ((playerIndex + gameIndex) % 5),
      free_throws_attempted: 3 + ((playerIndex + gameIndex) % 6),
      double_double: (playerIndex + gameIndex) % 5 === 0,
      triple_double: false,
    })))
  if (stats.length > 0) assertNoError('seed demo box scores', await admin.from('player_game_stats').upsert(stats, {
    onConflict: 'player_id,game_id',
  }))
  const storedStats = finishedGames.length === 0
    ? []
    : assertNoError('verify demo box scores', await admin
      .from('player_game_stats')
      .select('game_id')
      .in('game_id', finishedGames.map((game) => game.id)))
  const gamesWithStats = new Set(storedStats.map((row) => row.game_id))
  const missingGames = finishedGames.filter((game) => !gamesWithStats.has(game.id))
  if (missingGames.length > 0) {
    throw new Error(`seed demo box scores: ${missingGames.length} final game(s) have no stats`)
  }
  assertNoError('refresh demo player averages', await admin.rpc('refresh_player_search_caches'))

  assertNoError('seed demo projections', await admin.from('player_projections').upsert(players.map((player, index) => ({
    player_id: player.id,
    season_year: DEMO_SEASON_YEAR,
    week_number: DEMO_WEEK,
    projected_points: 28 + (index % 18),
    projected_minutes: 26 + (index % 10),
    projected_stat_points: 16 + (index % 12),
    projected_rebounds: 4 + (index % 7),
    projected_assists: 3 + (index % 8),
    projected_steals: 0.8 + ((index % 8) / 10),
    projected_blocks: 0.5 + ((index % 7) / 10),
    projected_three_pointers_made: 1 + (index % 4),
    projected_turnovers: 1 + (index % 3),
  })), { onConflict: 'player_id,season_year,week_number' }))

  return { players: players.length, rosters: rosters.length, lineups: lineupRows.length, games: games.length, stats: stats.length }
}

async function main() {
  const env = localStatus()
  const admin = createClient(env.url, env.secretKey, { auth: { persistSession: false } })
  const week = currentWeek()
  await removePreviousDemo(admin)
  const { created, clients } = await createManagers(admin, env)
  const fixture = await createLeague(admin, created, clients, week)
  const counts = await seedBasketball(admin, fixture, week)

  console.log(JSON.stringify({
    frontend: 'http://localhost:8081',
    studio: 'http://127.0.0.1:54323',
    email: managers[0].email,
    password: DEMO_PASSWORD,
    league: fixture.league.name,
    leagueId: fixture.league.id,
    week: `${week.start} to ${week.end}`,
    ...counts,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
