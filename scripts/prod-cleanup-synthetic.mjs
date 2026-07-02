import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'

const ROOT = process.cwd()
const SYNTHETIC_USERNAMES = new Set(['jeremy1', 'jeremy2'])
const SYNTHETIC_LEAGUE_SLUGS = new Set(['jeremy-gang-529c'])

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

const apply = process.argv.includes('--apply')
const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL
const adminKey = process.env.PANCAKE_SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET_KEY

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

const profiles = await must(
  'profiles',
  supabase
    .from('profiles')
    .select('id, username, display_name, created_at')
    .in('username', [...SYNTHETIC_USERNAMES]),
)

const syntheticLeagueRows = await must(
  'leagues',
  supabase
    .from('leagues')
    .select('id, slug, status, created_at')
    .in('slug', [...SYNTHETIC_LEAGUE_SLUGS]),
)

const members = await must(
  'league_members',
  supabase
    .from('league_members')
    .select('id, league_id, user_id')
    .in('user_id', profiles.map((profile) => profile.id)),
)

const profileById = new Map(profiles.map((profile) => [profile.id, profile]))
const syntheticLeagueById = new Map(syntheticLeagueRows.map((league) => [league.id, league]))
const leagueIds = new Set()
for (const member of members) {
  const league = syntheticLeagueById.get(member.league_id)
  const profile = profileById.get(member.user_id)
  if (
    league &&
    league.status === 'setup' &&
    SYNTHETIC_LEAGUE_SLUGS.has(league.slug) &&
    SYNTHETIC_USERNAMES.has(profile?.username)
  ) {
    leagueIds.add(league.id)
  }
}

const leagues = []
for (const leagueId of leagueIds) {
  const activity = {
    roster_players: await countRows('roster_players', { league_id: leagueId }),
    matchups: await countRows('matchups', { league_id: leagueId }),
    trades: await countRows('trades', { league_id: leagueId }),
    waiver_claims: await countRows('waiver_claims', { league_id: leagueId }),
    weekly_lineups: await countRows('weekly_lineups', { league_id: leagueId }),
  }
  const activityRows = Object.values(activity).reduce((sum, value) => sum + value, 0)
  leagues.push({ id: leagueId, activity, safeToDelete: activityRows === 0 })
}

const unsafeLeagues = leagues.filter((league) => !league.safeToDelete)
if (unsafeLeagues.length > 0) {
  throw new Error(`Refusing to delete league(s) with gameplay activity: ${unsafeLeagues.map((l) => l.id).join(', ')}`)
}

const actions = {
  mode: apply ? 'apply' : 'dry-run',
  syntheticProfiles: profiles.map((profile) => ({
    id: profile.id,
    username: profile.username,
    created_at: profile.created_at,
  })),
  leagues,
  deleted: {
    leagues: 0,
    users: 0,
  },
}

if (apply) {
  for (const league of leagues) {
    const { error } = await supabase.from('leagues').delete().eq('id', league.id)
    if (error) throw new Error(`delete league ${league.id}: ${error.message}`)
    actions.deleted.leagues += 1
  }

  for (const profile of profiles) {
    const { error } = await supabase.auth.admin.deleteUser(profile.id)
    if (error) throw new Error(`delete auth user ${profile.id}: ${error.message}`)
    actions.deleted.users += 1
  }
}

console.log(JSON.stringify(actions, null, 2))
