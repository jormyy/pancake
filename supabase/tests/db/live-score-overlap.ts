import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const [endpoint, port, protocols] of [
  [api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321', ['http:', 'https:']],
  [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322', ['postgres:', 'postgresql:']],
] as const) {
  const url = new URL(endpoint)
  assert.ok(/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535 &&
    ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === port &&
    protocols.some(protocol => protocol === url.protocol), `Refuse a target outside loopback port ${port}`)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const league = crypto.randomUUID(), season = crypto.randomUUID(), game = crypto.randomUUID()
const members = [crypto.randomUUID(), crypto.randomUUID()]
const players = [crypto.randomUUID(), crypto.randomUUID()]
const users: string[] = []
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const day = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
let year = 0
const nativeFetch = globalThis.fetch.bind(globalThis)
let armed = false
let staleRejections = 0
const scoringReads: number[] = []
let announce!: () => void
let resume!: () => void
const reached = new Promise<void>(resolve => { announce = resolve })
const barrier = new Promise<void>(resolve => { resume = resolve })
let pending: Promise<unknown> | undefined
async function q<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.equal(url.origin, api)
  const response = await nativeFetch(input, init)
  if (url.pathname.endsWith('/rpc/update_score_points_atomic') && !response.ok) {
    const failure = await response.clone().json()
    assert.equal(failure.code, 'PT409')
    assert.equal(failure.message, 'Score inputs changed or were not certified. Retry scoring.')
    staleRejections++
  }
  if (url.pathname.endsWith('/player_game_stats') && url.searchParams.get('select')?.includes('points,rebounds')) {
    const rows = await response.clone().json()
    scoringReads.push(rows.find((row: { player_id: string }) => row.player_id === players[0])?.points)
  }
  if (armed && url.pathname.endsWith('/player_game_stats') && url.searchParams.get('select')?.includes('points,rebounds')) {
    armed = false
    const rows = await response.clone().json()
    assert.equal(rows.find((row: { player_id: string }) => row.player_id === players[0])?.points, 20)
    announce()
    await barrier
  }
  return response
}
try {
  for (let candidate = 9101; candidate < 9201; candidate++) {
    if (!(await q(supabase.from('season_weeks').select('id').eq('season_year', candidate)))?.length) {
      year = candidate
      break
    }
  }
  assert.ok(year)
  for (let side = 0; side < 2; side++) {
    const { data, error } = await supabase.auth.admin.createUser({ email: `live-overlap-${members[side]}@example.test`,
      password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
      user_metadata: { username: `overlap_${members[side].replaceAll('-', '').slice(0, 16)}` } })
    if (error) throw error
    assert.ok(data.user)
    users.push(data.user.id)
  }
  await q(supabase.from('leagues').insert({ id: league, name: 'Synthetic live overlap', slug: league,
    commissioner_id: users[0], status: 'active', scoring_settings: { points: 1 } }))
  await q(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  await q(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: users[side],
    role: side ? 'manager' as const : 'commissioner' as const, team_name: `Side ${side}` }))))
  await q(supabase.from('season_weeks').insert({ season_year: year, week_number: 1, week_start: day(-1), week_end: day(5) }))
  await q(supabase.from('players').insert(players.map((id, side) => ({ id, first_name: 'Synthetic', last_name: id,
    position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? 'MIA' : 'BOS' }))))
  await q(supabase.from('roster_players').insert(players.map((player_id, side) => ({ player_id, league_id: league,
    league_season_id: season, member_id: members[side], acquired_via: 'draft', acquired_at: `${day(-2)}T12:00:00Z` }))))
  await q(supabase.from('nba_games').insert({ id: game, nba_game_id: `002-overlap-${game}`, season_year: year,
    week_number: 1, game_date: today, game_time: `${today}T00:00:00Z`, status: 'InProgress', home_team: 'BOS', away_team: 'MIA' }))
  await q(supabase.from('player_game_stats').insert(players.map((player_id, side) => ({ player_id, game_id: game,
    season_year: year, week_number: 1, points: side ? 10 : 20, did_not_play: false }))))
  await q(supabase.from('weekly_lineups').insert(players.map((player_id, side) => ({ player_id, league_id: league,
    league_season_id: season, member_id: members[side], week_number: 1, game_date: today, slot_type: 'PG' as const, is_auto_set: false }))))
  await q(supabase.from('matchups').insert({ league_id: league, league_season_id: season, week_number: 1,
    home_member_id: members[0], away_member_id: members[1], matchup_type: 'regular_season', home_points: 0, away_points: 0 }))
  const run = () => syncScores(league, new Date(), { recoverStats: false })
  armed = true
  pending = run().then(() => null, error => error)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([reached, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Score read barrier timed out')), 10000)
    })])
  } finally { clearTimeout(timeout) }
  await q(supabase.from('player_game_stats').update({ points: 80 }).eq('game_id', game).eq('player_id', players[0]))
  await run()
  const read = () => q(supabase.from('matchups').select('home_points,away_points,is_finalized').eq('league_season_id', season).single())
  const newer = await read()
  assert.equal(Number(newer?.home_points), 80)
  resume()
  const failure = await pending
  const after = await read()
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', newer, after, staleRejections, scoringReads, failure: String(failure) }))
  assert.equal(Number(after?.home_points), 80, 'Older scoring read overwrites a newer live score')
  assert.equal(failure, null, 'A stale scorer must recover once without retry telemetry')
  assert.equal(staleRejections, 1, 'The database must reject the actual stale publication')
  assert.deepEqual(scoringReads, [20, 80, 80], 'The retry must read the corrected stats again')
  assert.equal(after?.is_finalized, false)
} finally {
  armed = false
  resume()
  await pending
  globalThis.fetch = nativeFetch
  await q(supabase.from('leagues').delete().eq('id', league))
  await q(supabase.from('player_game_stats').delete().eq('game_id', game))
  await q(supabase.from('nba_games').delete().eq('id', game))
  await q(supabase.from('players').delete().in('id', players))
  if (year) await q(supabase.from('season_weeks').delete().eq('season_year', year))
  for (const user of users) {
    const { error } = await supabase.auth.admin.deleteUser(user)
    if (error) throw error
  }
}
