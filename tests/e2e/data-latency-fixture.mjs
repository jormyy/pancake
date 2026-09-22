import { randomUUID } from 'node:crypto'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

export const assertLocalLatencyFixtureTarget = (value) => {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Latency fixture preparation requires an isolated loopback Supabase URL')
  }
}

export const withLocalLatencyFixture = async ({ supabaseUrl, state, client, runBenchmark }) => {
  assertLocalLatencyFixtureTarget(supabaseUrl)
  const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
  if (!uuid(state?.leagueId) || !Array.isArray(state.users) || state.users.length < 2 ||
      !state.users.every((user) => uuid(user.id) && /^pancake-e2e-[^@]+@example\.com$/.test(user.email))) {
    throw new Error('Latency fixture preparation requires the synthetic seed league and users')
  }
  return runWithScenarioResourceOwner('local latency matchup', async (owner) => {
    const { data: season, error: seasonError } = await client.from('league_seasons')
      .select('id').eq('league_id', state.leagueId).eq('is_current', true).single()
    if (seasonError || !season?.id) throw new Error('Latency fixture requires exactly one current season')
    const { data: members, error: memberError } = await client.from('league_members')
      .select('id, user_id').eq('league_id', state.leagueId).order('id')
    const seededIds = new Set(state.users.map((user) => user.id))
    if (memberError || !members || members.length < 2 || !members.every((member) => seededIds.has(member.user_id))) {
      throw new Error('Latency fixture league members do not match the synthetic seed users')
    }
    const { data: existing, error: matchupError } = await client.from('matchups').select('id')
      .eq('league_id', state.leagueId).eq('league_season_id', season.id).limit(1).maybeSingle()
    if (matchupError) throw new Error('Latency fixture could not read the current matchup')
    if (existing) return { fixtureCreated: false, result: await runBenchmark() }
    const row = {
      id: randomUUID(), league_id: state.leagueId, league_season_id: season.id, week_number: 1,
      home_member_id: members[0].id, away_member_id: members[1].id, home_points: 0, away_points: 0,
    }
    let inserted = false
    owner.register('temporary current-season matchup', async () => {
      const { data, error } = await client.from('matchups').delete()
        .eq('id', row.id).eq('league_id', row.league_id).eq('league_season_id', row.league_season_id).select('id')
      if (error || (inserted && (data?.length !== 1 || data[0].id !== row.id))) {
        throw new Error('Latency fixture cleanup did not remove its exact matchup')
      }
    })
    const { error } = await client.from('matchups').insert(row)
    if (error) throw new Error('Latency fixture could not insert its temporary matchup')
    inserted = true
    return { fixtureCreated: true, result: await runBenchmark() }
  })
}
