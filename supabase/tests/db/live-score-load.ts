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
const leagues = [crypto.randomUUID(), crypto.randomUUID()]
const seasons = leagues.map(() => crypto.randomUUID())
const members = leagues.map(() => [crypto.randomUUID(), crypto.randomUUID()])
const players = [crypto.randomUUID(), crypto.randomUUID()]
const game = crypto.randomUUID()
const users: string[] = []
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const day = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
const durationMs = 180_000
const scorerPeriodMs = 20_000
let year = 0, points = 20, writes = 0, attempts = 0, rejected = 0, successes = 0, advances = 0
let firstRejectionAt = 0, recoveryMs: number | null = null, lastAdvanceAt = 0, longestGapMs = 0
const finalizedAfterMs: (number | null)[] = [null, null]
const previousPoints = [0, 0]
const nativeFetch = globalThis.fetch.bind(globalThis)
let armed = false, running = false
let writer: Promise<void> | undefined
async function q<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
async function write() {
  points++
  await q(supabase.from('player_game_stats').update({ points }).eq('game_id', game).eq('player_id', players[0]))
  writes++
}
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.equal(url.origin, api)
  const response = await nativeFetch(input, init)
  if (armed && url.pathname.endsWith('/player_game_stats') && url.searchParams.get('select')?.includes('points,rebounds')) {
    armed = false
    await response.clone().json()
    await write()
  }
  return response
}
try {
  for (let candidate = 9201; candidate < 9301; candidate++) {
    if (!(await q(supabase.from('season_weeks').select('id').eq('season_year', candidate)))?.length) {
      year = candidate
      break
    }
  }
  assert.ok(year)
  for (let side = 0; side < 2; side++) {
    const { data, error } = await supabase.auth.admin.createUser({ email: `live-load-${players[side]}@example.test`,
      password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
      user_metadata: { username: `load_${players[side].replaceAll('-', '').slice(0, 16)}` } })
    if (error) throw error
    assert.ok(data.user)
    users.push(data.user.id)
  }
  await q(supabase.from('season_weeks').insert([
    { season_year: year, week_number: 1, week_start: day(-8), week_end: day(-2) },
    { season_year: year, week_number: 2, week_start: day(-1), week_end: day(5) },
  ]))
  await q(supabase.from('players').insert(players.map((id, side) => ({ id, first_name: 'Synthetic', last_name: id,
    position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? 'MIA' : 'BOS' }))))
  await q(supabase.from('nba_games').insert({ id: game, nba_game_id: `002-load-${game}`, season_year: year,
    week_number: 1, game_date: day(-2), game_time: `${day(-2)}T00:00:00Z`, status: 'InProgress', home_team: 'BOS', away_team: 'MIA' }))
  await q(supabase.from('player_game_stats').insert(players.map((player_id, side) => ({ player_id, game_id: game,
    season_year: year, week_number: 1, points: side ? 10 : points, did_not_play: false }))))
  for (let index = 0; index < 2; index++) {
    await q(supabase.from('leagues').insert({ id: leagues[index], name: 'Synthetic sustained scoring', slug: leagues[index],
      commissioner_id: users[0], status: index ? 'playoffs' : 'active', scoring_settings: { points: 1 } }))
    await q(supabase.from('league_seasons').insert({ id: seasons[index], league_id: leagues[index], season_year: year, is_current: true }))
    await q(supabase.from('league_members').insert(members[index].map((id, side) => ({ id, league_id: leagues[index], user_id: users[side],
      role: side ? 'manager' as const : 'commissioner' as const, team_name: `Side ${side}` }))))
    await q(supabase.from('roster_players').insert(players.map((player_id, side) => ({ player_id, league_id: leagues[index],
      league_season_id: seasons[index], member_id: members[index][side], acquired_via: 'draft', acquired_at: `${day(-9)}T12:00:00Z` }))))
    await q(supabase.from('weekly_lineups').insert(players.map((player_id, side) => ({ player_id, league_id: leagues[index],
      league_season_id: seasons[index], member_id: members[index][side], week_number: 1, game_date: day(-2), slot_type: 'PG' as const, is_auto_set: false }))))
    await q(supabase.from('matchups').insert({ league_id: leagues[index], league_season_id: seasons[index], week_number: 1,
      home_member_id: members[index][0], away_member_id: members[index][1], matchup_type: index ? 'playoff_final' : 'regular_season',
      home_points: 0, away_points: 0 }))
  }
  const started = Date.now()
  lastAdvanceAt = started
  armed = true
  running = true
  writer = (async () => {
    for (let next = started + 1500; running; next += 1500) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, next - Date.now())))
      if (!running) break
      await write()
    }
  })()
  let markedFinal = false
  for (let next = started; Date.now() - started < durationMs; next += scorerPeriodMs) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, next - Date.now())))
    if (!markedFinal && Date.now() - started >= 60_000) {
      await q(supabase.from('nba_games').update({ status: 'Final', stats_synced_at: new Date().toISOString() }).eq('id', game))
      markedFinal = true
    }
    for (let index = 0; index < 2; index++) {
      attempts++
      try {
        await syncScores(leagues[index], new Date(), { recoverStats: false })
        successes++
      } catch (error) {
        assert.match(String(error), /Score sync failed/)
        rejected++
        if (!firstRejectionAt) firstRejectionAt = Date.now()
      }
      const row = await q(supabase.from('matchups').select('home_points,is_finalized').eq('league_season_id', seasons[index]).single())
      const current = Number(row?.home_points)
      assert.ok(current >= previousPoints[index], 'Published scores move backward')
      if (current > previousPoints[index]) {
        advances++
        longestGapMs = Math.max(longestGapMs, Date.now() - lastAdvanceAt)
        lastAdvanceAt = Date.now()
        if (index === 0 && firstRejectionAt && recoveryMs == null) recoveryMs = Date.now() - firstRejectionAt
        previousPoints[index] = current
      }
      if (row?.is_finalized && finalizedAfterMs[index] == null) finalizedAfterMs[index] = Date.now() - started
    }
  }
  running = false
  await writer
  const settledAt = Date.now()
  for (let index = 0; index < 2; index++) {
    await syncScores(leagues[index], new Date(), { recoverStats: false })
    const final = await q(supabase.from('matchups').select('home_points,home_max_possible_points,is_finalized').eq('league_season_id', seasons[index]).single())
    assert.equal(Number(final?.home_points), points)
    assert.equal(Number(final?.home_max_possible_points), points)
    assert.equal(final?.is_finalized, true)
    assert.ok(finalizedAfterMs[index] != null && finalizedAfterMs[index]! < durationMs, 'Finalization waits for the writer to stop')
  }
  const metrics = { provenance: 'SYNTHETIC', durationMs: Date.now() - started, writerPeriodMs: 1500, scorerPeriodMs,
    writes, attempts, rejected, successes, rejectionRate: rejected / attempts, advances, longestGapMs, recoveryMs,
    finalizedAfterMs, finalPoints: points, convergenceMs: Date.now() - settledAt, retry: 'next twenty-second scoring cycle' }
  console.log(JSON.stringify(metrics))
  assert.ok(rejected >= 1, 'Forced stale-read control must reject')
  assert.ok(recoveryMs != null && recoveryMs < 25_000, 'Next scoring cycle does not recover promptly')
  assert.ok(rejected / attempts <= 0.25, 'Rejections starve successful publications')
  assert.ok(advances >= 12 && longestGapMs < 25_000, 'Live scores stop advancing')
} finally {
  armed = false
  running = false
  await writer
  globalThis.fetch = nativeFetch
  await q(supabase.from('leagues').delete().in('id', leagues))
  await q(supabase.from('player_game_stats').delete().eq('game_id', game))
  await q(supabase.from('nba_games').delete().eq('id', game))
  await q(supabase.from('players').delete().in('id', players))
  if (year) await q(supabase.from('season_weeks').delete().eq('season_year', year))
  for (const user of users) {
    const { error } = await supabase.auth.admin.deleteUser(user)
    if (error) throw error
  }
}
