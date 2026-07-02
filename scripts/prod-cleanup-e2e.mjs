import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'

const ROOT = process.cwd()
const apply = process.argv.includes('--apply')

const E2E_EMAIL_PATTERNS = [
  /^pancake-e2e-.+@example\.com$/i,
  /^pancake-gameplay-.+@example\.com$/i,
  /^pancake-lineup-.+@example\.com$/i,
  /^pancake-waiver-.+@example\.com$/i,
  /^pancake-rookie-.+@example\.com$/i,
  /^pancake-playoff-.+@example\.com$/i,
  /^pancake-trade-.+@example\.com$/i,
  /^pancake-browser-league-.+@example\.com$/i,
]

const E2E_USERNAME_PREFIXES = [
  'pancake_e2e_',
  'pancake_gameplay_',
  'pancake_lineup_',
  'pancake_waiver_',
  'pancake_rookie_',
  'pancake_playoff_',
  'pancake_trade_',
  'pancake_browser_league_',
]

const E2E_LEAGUE_NAME_PREFIXES = [
  'Pancake E2E',
  'Pancake Browser Gameplay',
  'Pancake Browser Lineup',
  'Pancake Browser Waiver',
  'Pancake Browser Rookie',
  'Pancake Browser Playoff',
  'Pancake Browser Trade',
  'Pancake Browser League Lifecycle',
]

const loadEnvFile = (filePath) => {
  let contents
  try {
    contents = readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || process.env[match[1]] != null) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[match[1]] = value
  }
}

loadEnvFile(path.join(ROOT, '.env'))

const supabaseUrl = process.env.E2E_SUPABASE_URL || process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL
const adminKey = process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY ||
  process.env.PANCAKE_SUPABASE_SECRET_KEY ||
  process.env.E2E_SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SECRET_KEY

if (!supabaseUrl || !adminKey) {
  throw new Error('SUPABASE_URL/EXPO_PUBLIC_SUPABASE_URL and PANCAKE_SUPABASE_SECRET_KEY/SUPABASE_SECRET_KEY are required.')
}

const supabase = createClient(supabaseUrl, adminKey, {
  auth: { persistSession: false },
})

const must = async (label, promise) => {
  const result = await promise
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

const countRows = async (table, filters) => {
  let query = supabase.from(table).select('*', { count: 'exact', head: true })
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value)
  const { count, error } = await query
  if (error) throw new Error(`${table} count: ${error.message}`)
  return count ?? 0
}

const chunk = (values, size = 100) => {
  const chunks = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

const deleteIn = async (table, column, values, deleted) => {
  const uniqueValues = [...new Set(values.filter(Boolean))]
  if (uniqueValues.length === 0) return 0

  let total = 0
  for (const valuesChunk of chunk(uniqueValues)) {
    const { count, error } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .in(column, valuesChunk)
    if (error) throw new Error(`delete ${table}.${column}: ${error.message}`)
    total += count ?? 0
  }
  deleted.rows[table] = (deleted.rows[table] ?? 0) + total
  return total
}

const deleteLike = async (table, column, pattern, deleted) => {
  const { count, error } = await supabase
    .from(table)
    .delete({ count: 'exact' })
    .like(column, pattern)
  if (error) throw new Error(`delete ${table}.${column} LIKE ${pattern}: ${error.message}`)
  deleted.rows[table] = (deleted.rows[table] ?? 0) + (count ?? 0)
  return count ?? 0
}

const fetchIds = async (table, select, column, values) => {
  const uniqueValues = [...new Set(values.filter(Boolean))]
  if (uniqueValues.length === 0) return []

  const rows = []
  for (const valuesChunk of chunk(uniqueValues)) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .in(column, valuesChunk)
    if (error) throw new Error(`${table} ids: ${error.message}`)
    rows.push(...(data ?? []))
  }
  return rows
}

const listAllAuthUsers = async () => {
  const users = []
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error(`auth user list: ${error.message}`)
    users.push(...(data.users ?? []))
    if ((data.users ?? []).length < 1000) break
  }
  return users
}

const isE2EUsername = (username) => E2E_USERNAME_PREFIXES.some((prefix) => username?.startsWith(prefix))
const isE2EEmail = (email) => E2E_EMAIL_PATTERNS.some((pattern) => pattern.test(email ?? ''))
const isE2ELeague = (league) => (
  E2E_LEAGUE_NAME_PREFIXES.some((prefix) => league.name?.startsWith(prefix)) ||
  league.slug?.startsWith('pancake-e2e-')
)

const [profiles, authUsers, leagues, e2ePlayers] = await Promise.all([
  must('profiles', supabase.from('profiles').select('id, username, display_name, created_at')),
  listAllAuthUsers(),
  must('leagues', supabase.from('leagues').select('id, name, slug, status, created_at')),
  must('players', supabase.from('players').select('id, sportsdata_id, display_name').like('sportsdata_id', 'e2e-player-%')),
])

const e2eProfiles = profiles.filter((profile) => isE2EUsername(profile.username))
const profileUserIds = new Set(e2eProfiles.map((profile) => profile.id))
const e2eAuthUsers = authUsers.filter((user) => profileUserIds.has(user.id) || isE2EEmail(user.email))
const e2eUserIds = new Set([...profileUserIds, ...e2eAuthUsers.map((user) => user.id)])
const e2eLeagues = leagues.filter(isE2ELeague)
const leaguesById = new Map(leagues.map((league) => [league.id, league]))

const memberLeagues = e2eUserIds.size === 0
  ? []
  : await must(
    'league_members',
    supabase
      .from('league_members')
      .select('league_id, user_id')
      .in('user_id', [...e2eUserIds]),
  )

const leagueById = new Map(e2eLeagues.map((league) => [league.id, league]))
for (const member of memberLeagues) {
  const league = leaguesById.get(member.league_id)
  if (league && isE2ELeague(league)) {
    leagueById.set(member.league_id, league)
  }
}

const leagueIds = [...leagueById.keys()]
const e2eLeagueSeasons = await fetchIds('league_seasons', 'id, league_id, season_year', 'league_id', leagueIds)
const e2eSeasonYears = [...new Set(e2eLeagueSeasons.map((row) => row.season_year))]
const syntheticSeasonYears = e2eSeasonYears.filter((year) => Number(year) >= 3000)
const leagueActivity = []
for (const leagueId of leagueIds) {
  leagueActivity.push({
    leagueId,
    roster_players: await countRows('roster_players', { league_id: leagueId }),
    matchups: await countRows('matchups', { league_id: leagueId }),
    trades: await countRows('trades', { league_id: leagueId }),
    waiver_claims: await countRows('waiver_claims', { league_id: leagueId }),
    weekly_lineups: await countRows('weekly_lineups', { league_id: leagueId }),
  })
}

const actions = {
  mode: apply ? 'apply' : 'dry-run',
  leagues: leagueIds.map((id) => leagueById.get(id)),
  users: e2eAuthUsers.map((user) => ({ id: user.id, email: user.email, created_at: user.created_at })),
  profilesWithoutAuthUser: e2eProfiles
    .filter((profile) => !e2eAuthUsers.some((user) => user.id === profile.id))
    .map((profile) => ({ id: profile.id, username: profile.username, created_at: profile.created_at })),
  players: e2ePlayers.map((player) => ({ id: player.id, sportsdata_id: player.sportsdata_id })),
  syntheticSeasonYears,
  leagueActivity,
  deleted: {
    leagues: 0,
    users: 0,
    profiles: 0,
    players: 0,
    rows: {},
  },
}

if (apply) {
  const draftRows = await fetchIds('drafts', 'id', 'league_id', leagueIds)
  const draftIds = draftRows.map((row) => row.id)
  const nominationRows = await fetchIds('nominations', 'id', 'draft_id', draftIds)
  const nominationIds = nominationRows.map((row) => row.id)
  const tradeRows = await fetchIds('trades', 'id', 'league_id', leagueIds)
  const tradeIds = tradeRows.map((row) => row.id)
  const rosterRows = await fetchIds('roster_players', 'id', 'league_id', leagueIds)
  const rosterIds = rosterRows.map((row) => row.id)
  const e2eGameRows = await must(
    'e2e nba games',
    supabase
      .from('nba_games')
      .select('id')
      .like('sportsdata_game_id', 'e2e-%'),
  )
  const e2eGameIds = e2eGameRows.map((row) => row.id)
  const e2ePlayerIds = e2ePlayers.map((player) => player.id)

  await deleteIn('trade_vetos', 'trade_id', tradeIds, actions.deleted)
  await deleteIn('trade_items', 'trade_id', tradeIds, actions.deleted)
  await deleteIn('bids', 'nomination_id', nominationIds, actions.deleted)
  await deleteIn('trade_drop_reservations', 'roster_player_id', rosterIds, actions.deleted)
  await deleteIn('draft_room_members', 'draft_id', draftIds, actions.deleted)
  await deleteIn('draft_orders', 'draft_id', draftIds, actions.deleted)
  await deleteIn('draft_budgets', 'draft_id', draftIds, actions.deleted)
  await deleteIn('snake_draft_picks', 'draft_id', draftIds, actions.deleted)

  for (const table of [
    'league_activity',
    'league_audit_logs',
    'draft_audit_logs',
    'roster_transactions',
    'waiver_wire_log',
    'waiver_claims',
    'trade_block_items',
    'weekly_add_counts',
    'faab_balances',
    'lineup_optimizer_settings',
    'weekly_lineups',
    'standings',
    'rps_challenges',
    'matchups',
    'waiver_priorities',
    'draft_picks',
  ]) {
    await deleteIn(table, 'league_id', leagueIds, actions.deleted)
  }

  await deleteIn('nominations', 'draft_id', draftIds, actions.deleted)
  await deleteIn('trades', 'league_id', leagueIds, actions.deleted)
  await deleteIn('drafts', 'league_id', leagueIds, actions.deleted)
  await deleteIn('roster_players', 'league_id', leagueIds, actions.deleted)
  await deleteIn('lineup_slot_templates', 'league_id', leagueIds, actions.deleted)
  await deleteIn('league_seasons', 'league_id', leagueIds, actions.deleted)
  await deleteIn('league_members', 'league_id', leagueIds, actions.deleted)
  actions.deleted.leagues = await deleteIn('leagues', 'id', leagueIds, actions.deleted)

  await deleteIn('player_game_stats', 'player_id', e2ePlayerIds, actions.deleted)
  await deleteIn('player_game_stats', 'game_id', e2eGameIds, actions.deleted)
  await deleteIn('player_projections', 'player_id', e2ePlayerIds, actions.deleted)
  actions.deleted.players = await deleteLike('players', 'sportsdata_id', 'e2e-player-%', actions.deleted)
  await deleteLike('nba_games', 'sportsdata_game_id', 'e2e-%', actions.deleted)
  await deleteIn('season_weeks', 'season_year', syntheticSeasonYears, actions.deleted)

  for (const user of e2eAuthUsers) {
    const { error } = await supabase.auth.admin.deleteUser(user.id)
    if (error) throw new Error(`delete auth user ${user.id}: ${error.message}`)
    actions.deleted.users += 1
  }

  for (const profile of actions.profilesWithoutAuthUser) {
    const { error } = await supabase.from('profiles').delete().eq('id', profile.id)
    if (error) throw new Error(`delete profile ${profile.id}: ${error.message}`)
    actions.deleted.profiles += 1
  }

  if (e2ePlayers.length > 0) {
    const { error } = await supabase.from('players').delete().like('sportsdata_id', 'e2e-player-%')
    if (error) throw new Error(`delete E2E players: ${error.message}`)
    actions.deleted.players = e2ePlayers.length
  }
}

console.log(JSON.stringify(actions, null, 2))
