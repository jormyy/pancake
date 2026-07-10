import { createClient } from '@supabase/supabase-js'

export const EXPECTED_DEFAULT_LINEUP_SLOTS = {
  PG: 1, SG: 1, SF: 1, PF: 1, C: 1, G: 1, F: 1, UTIL: 3, BE: 10, IR: 2,
}

export const currentSeasonYear = (now = new Date()) => (
  now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
)

export const ensureSyntheticSeasonWeeks = async (supabase, seasonYear, throughWeek, label) => {
  const rows = Array.from({ length: throughWeek }, (_, index) => ({
    season_year: seasonYear,
    week_number: index + 1,
    week_start: new Date(Date.UTC(2090, 0, 1 + index * 7)).toISOString().slice(0, 10),
    week_end: new Date(Date.UTC(2090, 0, 7 + index * 7)).toISOString().slice(0, 10),
  }))
  const { error } = await supabase.from('season_weeks').upsert(rows, { onConflict: 'season_year,week_number' })
  if (error) throw new Error(`${label}: synthetic season_weeks upsert failed: ${error.message}`)
}

const e2eCode = () => Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(2, 18).toUpperCase().padEnd(16, '0')

export const createDisposableLeagueFromSeedUsers = async ({
  supabase, state, season, label, userCount, resourceOwner,
  seasonYear = undefined, status = 'active', playoffStartWeek = 20,
}) => {
  if (!resourceOwner) throw new Error(`${label}: disposable fixture requires a scenario resource owner`)
  if (!state?.password || !Array.isArray(state.users) || state.users.length < userCount) {
    throw new Error(`${label}: scenario requires ${userCount} seeded users from npm run e2e:seed`)
  }
  const unique = `${state.runId ?? 'manual'}-${season}-${Date.now().toString(36)}`
  const { data: league, error: leagueError } = await supabase.from('leagues').insert({
    name: `Pancake E2E ${label.replace(/[^A-Z0-9]+/gi, ' ')} ${unique}`,
    slug: `pancake-e2e-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${unique}`,
    invite_code: e2eCode(), commissioner_id: state.users[0].id, status, playoff_start_week: playoffStartWeek,
  }).select('id, playoff_start_week, status').single()
  if (leagueError) throw new Error(`${label} league insert: ${leagueError.message}`)

  resourceOwner.register(`league ${league.id}`, async () => {
    const { error: tradeError } = await supabase.from('trades')
      .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
      .eq('league_id', league.id).eq('status', 'accepted')
    const { error: deleteError } = await supabase.from('leagues').delete().eq('id', league.id)
    const failures = [tradeError, deleteError].filter(Boolean).map((error) => new Error(error.message))
    if (failures.length > 0) throw new AggregateError(failures, `${label}: league disposal failed`)
  })

  const { data: leagueSeason, error: seasonError } = await supabase.from('league_seasons').insert({
    league_id: league.id, season_year: seasonYear ?? 3000 + season, is_current: true,
  }).select('id, season_year').single()
  if (seasonError) throw new Error(`${label} season insert: ${seasonError.message}`)
  const orderByUserId = new Map(state.users.map((user, index) => [user.id, index]))
  const { data: insertedMembers, error: membersError } = await supabase.from('league_members')
    .insert(state.users.slice(0, userCount).map((user, index) => ({
      league_id: league.id, user_id: user.id, role: index === 0 ? 'commissioner' : 'manager',
      team_name: `${label} Seed ${index + 1}`,
    }))).select('id, user_id, team_name')
  if (membersError) throw new Error(`${label} members insert: ${membersError.message}`)
  const members = [...(insertedMembers ?? [])].sort((a, b) => (
    (orderByUserId.get(a.user_id) ?? 999) - (orderByUserId.get(b.user_id) ?? 999)
  ))
  if (members.length < userCount) throw new Error(`${label}: disposable league has ${members.length} members; expected ${userCount}`)
  return { league, leagueSeason, members }
}

export const signInSupabaseClient = async (env, email, password, label) => {
  if (!env.anonKey) throw new Error(`${label}: requires a Supabase publishable key`)
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`${label}: sign-in failed for ${email}: ${error.message}`)
  return client
}

export const readLeagueSettingsForClient = async (client, leagueId, label) => {
  const { data, error } = await client.from('leagues')
    .select('id, scoring_settings, roster_size, ir_slots, taxi_slots, auction_budget, playoff_start_week')
    .eq('id', leagueId).single()
  if (error || !data) throw new Error(`${label}: league settings read failed: ${error?.message ?? 'missing row'}`)
  return data
}

export const readLineupSlotsForClient = async (client, leagueId, label) => {
  const { data, error } = await client.from('lineup_slot_templates').select('slot_type, slot_count').eq('league_id', leagueId)
  if (error) throw new Error(`${label}: lineup slot read failed: ${error.message}`)
  return data ?? []
}

export const readPlayerBySleeperId = async (supabase, sleeperId, label) => {
  const { data, error } = await supabase.from('players')
    .select('id, sportsdata_id, first_name, last_name, display_name, sleeper_id, position, eligible_positions, status, injury_status, nba_team, years_exp')
    .eq('sleeper_id', sleeperId).limit(1)
  if (error) throw new Error(`${label}: player lookup for sleeper_id=${sleeperId} failed: ${error.message}`)
  return data?.[0] ?? null
}

export const ensureSleeperFixturePlayer = async (supabase, input, label) => {
  const { sleeperId, firstName, lastName, position } = input
  const existing = await readPlayerBySleeperId(supabase, sleeperId, label)
  const fields = {
    first_name: firstName, last_name: lastName, sleeper_id: sleeperId, position,
    eligible_positions: [position], status: 'Inactive', injury_status: 'Stale', nba_team: 'OLD', years_exp: 99,
  }
  const query = existing
    ? supabase.from('players').update(fields).eq('id', existing.id)
    : supabase.from('players').insert({ ...fields, sportsdata_id: `e2e-injury-${sleeperId}` })
  const { data, error } = await query
    .select('id, sportsdata_id, first_name, last_name, display_name, sleeper_id, position, eligible_positions, status, injury_status, nba_team, years_exp').single()
  if (error) throw new Error(`${label}: fixture player write failed for sleeper_id=${sleeperId}: ${error.message}`)
  return data
}
