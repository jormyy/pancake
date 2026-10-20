import { strict as assert } from 'node:assert'
import { liveIngestionProvider } from './live-ingestion-provider.ts'

const api = Deno.env.get('SUPABASE_URL')!, db = Deno.env.get('SUPABASE_DB_URL')!
for (const [endpoint, port] of [[api, 57321], [db, 57322]] as const) {
  const url = new URL(endpoint)
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && Number(url.port) === port)
}
const origin = 'http://127.0.0.1:57380'
const provider = Deno.serve({ hostname: '127.0.0.1', port: 57380, onListen() {} }, liveIngestionProvider())
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/static/json`)
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { runLivePoll } = await import('../../functions/live-poll/runner.ts')
const league = crypto.randomUUID(), season = crypto.randomUUID(), game = crypto.randomUUID()
const members = [crypto.randomUUID(), crypto.randomUUID()]
const players = [crypto.randomUUID(), crypto.randomUUID()]
const personIds = [0, 1].map(side => 900000000 + crypto.getRandomValues(new Uint32Array(1))[0] + side)
const providerGameId = `002${String(crypto.getRandomValues(new Uint32Array(1))[0] % 100000000).padStart(8, '0')}`
const users: string[] = []
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const day = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
let year = 0, armed = false, rejectedAt = 0
const nativeFetch = globalThis.fetch.bind(globalThis)
async function q<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
async function control(mode: string) {
  const response = await nativeFetch(`${origin}/control`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gameId: providerGameId, homePersonId: personIds[0], awayPersonId: personIds[1], mode }) })
  assert.equal(response.status, 200)
  await response.text()
}
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.ok([api, origin].includes(url.origin))
  const response = await nativeFetch(input, init)
  if (armed && url.pathname.endsWith('/player_game_stats') && url.searchParams.get('select')?.includes('points,rebounds')) {
    armed = false
    await response.clone().json()
    await q(supabase.from('player_game_stats').update({ points: 777 }).eq('game_id', game).eq('player_id', players[0]))
    rejectedAt = Date.now()
    await control('final')
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
    position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? 'MIA' : 'BOS', nba_id: String(personIds[side]) }))))
  await q(supabase.from('roster_players').insert(players.map((player_id, side) => ({ player_id, league_id: league,
    league_season_id: season, member_id: members[side], acquired_via: 'draft', acquired_at: `${day(-2)}T12:00:00Z` }))))
  await q(supabase.from('nba_games').insert({ id: game, nba_game_id: providerGameId, season_year: year,
    week_number: 1, game_date: today, game_time: `${today}T00:00:00Z`, status: 'InProgress', home_team: 'BOS', away_team: 'MIA' }))
  await q(supabase.from('player_game_stats').insert(players.map((player_id, side) => ({ player_id, game_id: game,
    season_year: year, week_number: 1, points: side ? 10 : 20, did_not_play: false }))))
  await q(supabase.from('weekly_lineups').insert(players.map((player_id, side) => ({ player_id, league_id: league,
    league_season_id: season, member_id: members[side], week_number: 1, game_date: today, slot_type: 'PG' as const, is_auto_set: false }))))
  await q(supabase.from('matchups').insert({ league_id: league, league_season_id: season, week_number: 1,
    home_member_id: members[0], away_member_id: members[1], matchup_type: 'regular_season', home_points: 0, away_points: 0 }))
  await control('active')
  armed = true
  const started = Date.now()
  const response = await runLivePoll(new Request(`${api}/functions/v1/live-poll`, { method: 'POST' }))
  const result = await response.json()
  assert.equal(response.status, 500, 'The run retains the first tick failure in its report')
  assert.equal(result.ticks, 2)
  assert.ok(result.failures.some((failure: string) => failure.includes('Score sync failed')))
  const final = await q(supabase.from('matchups').select('home_points,away_points,is_finalized').eq('league_season_id', season).single())
  assert.deepEqual(final, { home_points: 12, away_points: 1, is_finalized: true })
  const recoveryMs = Date.now() - rejectedAt
  assert.ok(rejectedAt && recoveryMs >= 18_000 && recoveryMs < 25_000)
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', worker: 'actual runLivePoll', elapsedMs: Date.now() - started,
    recoveryMs, ticks: result.ticks, failures: result.failures.length, final }))
} finally {
  armed = false
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
  await provider.shutdown()
}
