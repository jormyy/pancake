import { strict as assert } from 'node:assert'

// Final-score recipe for the live-poll tick. In the sim-t12 replay of 2195c211
// three games kept their last mid-game scoreboard score after Final. This runs
// the real ingestTick() under the real live-poll lease against this lane's
// stack. The NBA CDN is an in-process fake serving SYNTHETIC scoreboards and
// box scores in the CDN shape:
// - Game A drops off todaysScoreboard while its box turns Final (the replay's
//   midnight-ET rollover).
// - Game B's scoreboard is one tick behind its Final box, with the other team
//   still ahead on the scoreboard.
// - Game K stays live, so the third tick fetches the scoreboard again and
//   serves stale InProgress samples for A and B.
// Assertions read the persisted nba_games and player_game_stats rows.
const api = Deno.env.get('SUPABASE_URL')
const apiPort = Deno.env.get('PANCAKE_TEST_API_PORT')
assert.ok(api && apiPort, 'SUPABASE_URL and PANCAKE_TEST_API_PORT are required')
const apiUrl = new URL(api)
assert.ok(['127.0.0.1', 'localhost'].includes(apiUrl.hostname) && ['http:', 'https:'].includes(apiUrl.protocol) &&
  apiUrl.port === apiPort, `Refuse a target outside loopback port ${apiPort}`)
const protectedPort = /^(543|574|582)\d\d$/
assert.ok(!protectedPort.test(apiPort), `Port ${apiPort} belongs to a protected stack`)

type Line = { status: 2 | 3; period: number; clock: string; text: string; home: number; away: number }
const live = (period: number, minutes: number, seconds: number, home: number, away: number): Line => ({
  status: 2, period, clock: `PT${String(minutes).padStart(2, '0')}M${String(seconds).padStart(2, '0')}.00S`,
  text: `Q${period} ${minutes}:${String(seconds).padStart(2, '0')}`, home, away,
})
const final = (home: number, away: number): Line => ({ status: 3, period: 4, clock: 'PT00M00.00S', text: 'Final', home, away })
const random = () => crypto.getRandomValues(new Uint32Array(1))[0]
const providerBase = random() % 99_999_000
const personBase = 900_000_000 + random() % 1_000_000_000
const games = [['A', 'LAL', 'MIN'], ['B', 'LAC', 'PHX'], ['K', 'POR', 'GSW']].map(([key, home, away], index) => ({
  key, home, away, id: crypto.randomUUID(), providerId: `002${String(providerBase + index).padStart(8, '0')}`,
  players: [crypto.randomUUID(), crypto.randomUUID()], personIds: [personBase + 2 * index, personBase + 2 * index + 1],
}))
// A null scoreboard line means the game is missing from todaysScoreboard.
const ticks: { board: (Line | null)[]; box: Line[] }[] = [
  { board: [live(4, 11, 34, 85, 76), live(4, 2, 0, 96, 98), live(2, 6, 0, 40, 38)],
    box: [live(4, 11, 34, 85, 76), live(4, 2, 0, 96, 98), live(2, 6, 0, 40, 38)] },
  { board: [null, live(4, 0, 1, 100, 101), live(2, 5, 0, 42, 40)],
    box: [final(110, 103), final(102, 101), live(2, 5, 0, 42, 40)] },
  { board: [live(4, 11, 34, 85, 76), live(4, 0, 1, 100, 101), live(2, 4, 0, 44, 42)],
    box: [final(110, 103), final(102, 101), live(2, 4, 0, 44, 42)] },
]
const statistics = Object.fromEntries(['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal',
  'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal',
  'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers'].map(key => [key, 0]))
let phase = 0
const requests: { tick: number; path: string }[] = []
function team(index: number, line: Line, side: 0 | 1, withPlayers: boolean) {
  const game = games[index]
  return { teamTricode: side ? game.away : game.home, score: side ? line.away : line.home,
    ...withPlayers ? { players: [{ personId: game.personIds[side], name: `Synthetic ${game.personIds[side]}`, played: '1',
      statistics: { ...statistics, minutes: 'PT36M00.00S', points: side ? line.away : line.home } }] } : {} }
}
function feedGame(index: number, line: Line, withPlayers: boolean) {
  return { gameId: games[index].providerId, gameStatus: line.status, gameStatusText: line.text, period: line.period,
    gameClock: line.clock, ...withPlayers ? { gameEt: null } : {},
    homeTeam: team(index, line, 0, withPlayers), awayTeam: team(index, line, 1, withPlayers) }
}
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
  const path = new URL(request.url).pathname
  requests.push({ tick: phase, path })
  const plan = ticks[phase - 1]
  if (plan && path === '/static/json/liveData/scoreboard/todaysScoreboard_00.json') {
    return Response.json({ scoreboard: { games: plan.board.flatMap((line, index) => line ? [feedGame(index, line, false)] : []) } })
  }
  const index = games.findIndex(game => path === `/static/json/liveData/boxscore/boxscore_${game.providerId}.json`)
  if (plan && index >= 0) return Response.json({ game: feedGame(index, plan.box[index], true) })
  return new Response('Unexpected local provider request', { status: 404 })
})
const cdnPort = String(provider.addr.port)
assert.ok(!protectedPort.test(cdnPort), `Port ${cdnPort} belongs to a protected stack`)
Deno.env.set('NBA_CDN_BASE_URL', `http://127.0.0.1:${cdnPort}/static/json`)
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { ingestTick } = await import('../../functions/live-poll/runner.ts')
const { withWorkContext } = await import('../../functions/_shared/workContext.ts')
const { LIVE_POLL_LEASE_TTL_SECONDS, LIVE_POLL_LOCK_KEY } = await import('../../functions/_shared/livePoll.ts')
async function q<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const ids = games.map(game => game.id)
async function stored() {
  const rows = await q(supabase.from('nba_games')
    .select('id,status,home_score,away_score,game_status_text,live_scoreboard_elapsed_seconds,stats_synced_at').in('id', ids)) ?? []
  return games.map(game => {
    const row = rows.find(candidate => candidate.id === game.id)!
    return { game: game.key, status: row.status, score: [row.home_score, row.away_score], text: row.game_status_text,
      winner: row.home_score > row.away_score ? game.home : row.away_score > row.home_score ? game.away : null,
      elapsed: row.live_scoreboard_elapsed_seconds === null ? null : Number(row.live_scoreboard_elapsed_seconds),
      synced: row.stats_synced_at !== null }
  })
}
const tickPaths = (tick: number) => requests.filter(row => row.tick === tick).map(row => row.path.split('/').at(-1)).sort()

let holder: string | null = null
let inserted = false
let before: Set<string> | null = null
async function newScoreboardRuns(): Promise<string[]> {
  if (!before) return []
  const rows = await q(supabase.from('sync_runs').select('id').eq('function_name', 'source:nba-cdn-scoreboard')) ?? []
  return rows.map(row => row.id).filter(id => !before!.has(id))
}
try {
  assert.deepEqual(await q(supabase.rpc('get_live_poll_work')), [], 'Refuse: live-poll work exists outside this recipe')
  let year = 0
  for (let candidate = 9101; candidate < 9201 && !year; candidate++) {
    if (!(await q(supabase.from('nba_games').select('id').eq('season_year', candidate).limit(1)))?.length) year = candidate
  }
  assert.ok(year)
  holder = await q(supabase.rpc('try_live_poll_lease', { p_lock_key: LIVE_POLL_LOCK_KEY, p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS }))
  assert.ok(holder, 'Refuse: another live-poll worker holds the lease')
  const lease: string = holder
  before = new Set((await q(supabase.from('sync_runs').select('id').eq('function_name', 'source:nba-cdn-scoreboard')) ?? []).map(row => row.id))
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  inserted = true
  await q(supabase.from('players').insert(games.flatMap(game => game.players.map((id, side) => ({ id, first_name: 'Synthetic',
    last_name: id, position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? game.away : game.home,
    nba_id: String(game.personIds[side]) })))))
  await q(supabase.from('nba_games').insert(games.map(game => ({ id: game.id, nba_game_id: game.providerId, season_year: year,
    week_number: 1, game_date: today, game_time: `${today}T00:00:00Z`, status: 'InProgress', home_team: game.home, away_team: game.away }))))
  async function tick(index: number) {
    phase = index
    assert.equal(await q(supabase.rpc('renew_live_poll_lease', { p_lock_key: LIVE_POLL_LOCK_KEY, p_holder_id: lease,
      p_ttl_seconds: LIVE_POLL_LEASE_TTL_SECONDS })), true, 'The recipe lost its live-poll lease')
    const result = await withWorkContext({ signal: AbortSignal.timeout(18_000), livePollHolder: lease }, () => ingestTick(lease))
    assert.deepEqual(result.failures, [], `Tick ${index} failed`)
    const state = await stored()
    console.log(JSON.stringify({ provenance: 'SYNTHETIC', tick: index, keepRunning: result.keepRunning, lines: result.lines,
      requests: tickPaths(index), state }))
    return state
  }

  assert.deepEqual(await tick(1), [
    { game: 'A', status: 'InProgress', score: [85, 76], text: 'Q4 11:34', winner: 'LAL', elapsed: 2186, synced: false },
    { game: 'B', status: 'InProgress', score: [96, 98], text: 'Q4 2:00', winner: 'PHX', elapsed: 2760, synced: false },
    { game: 'K', status: 'InProgress', score: [40, 38], text: 'Q2 6:00', winner: 'POR', elapsed: 1080, synced: false },
  ], 'Tick 1 stores the mid-game scoreboard samples')
  const settled = [
    { game: 'A', status: 'Final', score: [110, 103], text: 'Final', winner: 'LAL', elapsed: 0, synced: true },
    { game: 'B', status: 'Final', score: [102, 101], text: 'Final', winner: 'LAC', elapsed: 0, synced: true },
  ]
  assert.deepEqual(await tick(2), [...settled,
    { game: 'K', status: 'InProgress', score: [42, 40], text: 'Q2 5:00', winner: 'POR', elapsed: 1140, synced: false },
  ], 'The final box sets the final score, text and winner when the scoreboard is missing or one tick behind')
  assert.deepEqual(await tick(3), [...settled,
    { game: 'K', status: 'InProgress', score: [44, 42], text: 'Q2 4:00', winner: 'POR', elapsed: 1200, synced: false },
  ], 'A later stale scoreboard cannot overwrite a final score')
  const scoreboard = 'todaysScoreboard_00.json'
  const box = (index: number) => `boxscore_${games[index].providerId}.json`
  assert.deepEqual([1, 2, 3].map(tickPaths), [
    [box(0), box(1), box(2), scoreboard].sort(), [box(0), box(1), box(2), scoreboard].sort(), [box(2), scoreboard].sort(),
  ], 'Each tick fetched the scoreboard once and only the boxes of games in work')
  for (const [index, line, elapsed] of [[0, ticks[0].board[0]!, 2186], [1, ticks[1].board[1]!, 2879]] as const) {
    assert.equal(await q(supabase.rpc('save_live_scoreboard_atomic', { p_game_id: games[index].id,
      p_provider_game_id: games[index].providerId, p_status: 'InProgress', p_home_score: line.home,
      p_away_score: line.away, p_status_text: line.text, p_elapsed_seconds: elapsed })), false,
    `A stale InProgress sample is refused for game ${games[index].key}`)
  }
  assert.deepEqual((await stored()).slice(0, 2), settled, 'Refused stale samples leave the final scores')
  const points = await q(supabase.from('player_game_stats').select('player_id,points').in('game_id', ids.slice(0, 2))) ?? []
  assert.deepEqual(games.slice(0, 2).flatMap(game => game.players.map(id => points.find(row => row.player_id === id)?.points)),
    [110, 103, 102, 101], 'The final box stats are stored')
  assert.equal((await newScoreboardRuns()).length, 3, 'Each tick recorded one scoreboard source run')
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', pass: 'live-t12-final-score', games: games.map(game => game.key) }))
} finally {
  try {
    if (inserted) {
      await q(supabase.from('player_game_stats').delete().in('game_id', ids))
      await q(supabase.from('nba_games').delete().in('id', ids))
      await q(supabase.from('players').delete().in('id', games.flatMap(game => game.players)))
    }
    // The held lease keeps every other live-poll tick out, so new scoreboard source runs are this recipe's.
    const runs = await newScoreboardRuns()
    if (runs.length) await q(supabase.from('sync_runs').delete().in('id', runs))
  } finally {
    if (holder) await q(supabase.rpc('release_live_poll_lease', { p_lock_key: LIVE_POLL_LOCK_KEY, p_holder_id: holder }))
    await provider.shutdown()
  }
}
