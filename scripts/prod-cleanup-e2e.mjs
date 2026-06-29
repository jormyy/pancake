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

const memberLeagues = e2eUserIds.size === 0
  ? []
  : await must(
    'league_members',
    supabase
      .from('league_members')
      .select('league_id, user_id, leagues(id, name, slug, status, created_at)')
      .in('user_id', [...e2eUserIds]),
  )

const leagueById = new Map(e2eLeagues.map((league) => [league.id, league]))
for (const member of memberLeagues) {
  if (member.leagues && isE2ELeague(member.leagues)) {
    leagueById.set(member.league_id, member.leagues)
  }
}

const leagueIds = [...leagueById.keys()]
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
  leagueActivity,
  deleted: {
    leagues: 0,
    users: 0,
    profiles: 0,
    players: 0,
  },
}

if (apply) {
  for (const leagueId of leagueIds) {
    const { error } = await supabase.from('leagues').delete().eq('id', leagueId)
    if (error) throw new Error(`delete league ${leagueId}: ${error.message}`)
    actions.deleted.leagues += 1
  }

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
