import assert from 'node:assert/strict'
import { recordedLiveFeeds, recordedPointChanges, recordedReplayRounds, percentile95 } from '../../scripts/season-sim/live-fallback-check.mjs'
import { checkMatchupPoints } from '../../scripts/season-sim/score-oracle.mjs'

const Deno = globalThis['Deno']
const target = new URL(Deno.env.get('SUPABASE_URL'))
assert.equal(target.origin, `http://127.0.0.1:${Deno.env.get('PANCAKE_TEST_API_PORT') ?? '63621'}`)
const NativeDate = Date
let businessAt = Date.parse('2026-10-30T01:00:50Z')
const nativeFetch = globalThis.fetch
const operations = []
const mode = Deno.env.get('LIVE_REPLAY_MODE') ?? 'espn'
const sessionFile = Deno.args.find(arg => arg.startsWith('--session='))?.slice('--session='.length)
assert.ok(sessionFile, 'A fixed recording session is required')
const records = await recordedLiveFeeds(sessionFile)
const allRecords = await recordedLiveFeeds()
const injectedNbaLagMs = Number(Deno.args.find(arg => arg.startsWith('--nba-lag-ms='))?.split('=')[1] ?? 1_200_000)
assert.ok(Number.isSafeInteger(injectedNbaLagMs) && injectedNbaLagMs >= 0)
const rounds = recordedReplayRounds(records)
const boards = rounds.map(round => round.board)
const nbaBoards = allRecords.filter(row => row.file.includes('-nba-scoreboard.json'))
const nbaBoxes = allRecords.filter(row => row.file.includes('-nba-boxscore-'))
const gameIds = [...new Set(records.filter(row => row.file.includes('-nba-boxscore-')).map(row => row.payload.game.gameId))]
assert.equal(gameIds.length, 2)
const delayed = rows => rows.filter(row => Date.parse(row.receivedAt) + injectedNbaLagMs <= businessAt).at(-1) ?? rows[0]
let scoreboard = boards[0], summaries = new Map(), timeout = false, espnTimeout = false
let boardCalls = 0, summaryCalls = 0, identityReads = 0
Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
Deno.env.set('ESPN_LIVE_BASE_URL', 'http://espn.invalid')
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname === 'nba.invalid') {
    if (timeout) return await new Promise((resolve, reject) => {
      const signal = init.signal
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const match = /boxscore_(\d+)\.json/.exec(url.pathname)
    const row = match ? delayed(nbaBoxes.filter(row => row.payload.game.gameId === match[1])) : delayed(nbaBoards)
    assert.ok(row, `Unrecorded NBA request: ${url.pathname}`)
    return Response.json(row.payload, { headers: { 'last-modified': row.headers['last-modified'] ?? new NativeDate(Date.parse(row.receivedAt)).toUTCString() } })
  }
  if (url.hostname === 'espn.invalid') {
    if (espnTimeout) return await new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }) })
    if (url.pathname.endsWith('/scoreboard')) { boardCalls++; return Response.json(scoreboard.payload) }
    summaryCalls++
    assert.ok(summaries.has(url.searchParams.get('event')))
    return Response.json(summaries.get(url.searchParams.get('event')).payload)
  }
  assert.equal(url.origin, target.origin)
  if (url.pathname.endsWith('/players') && url.searchParams.get('select') === 'id,espn_id,nba_id') identityReads++
  const response = await nativeFetch(input, init)
  if (!response.ok) {
    const body = await response.clone().json().catch(() => ({}))
    const args = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    operations.push({ path: url.pathname, code: body.code, message: body.message, details: body.details,
      game: args.p_game_id, season: args.p_league_season_id, league: args.p_league_id, week: args.p_week_number })
  }
  if (url.pathname.endsWith('/get_live_poll_work') && response.ok) {
    const body = await response.json()
    return Response.json(body.filter(game => gameIds.includes(game.nba_game_id)))
  }
  return response
}
const { supabase } = await import('../../supabase/functions/_shared/supabase.ts')
const { syncScores } = await import('../../supabase/functions/_shared/syncScores.ts')
const baselineRoot = Deno.env.get('LIVE_REPLAY_FUNCTIONS_ROOT')
const { ingestTick } = await import(baselineRoot ? new URL(`${baselineRoot}/live-poll/runner.ts`, import.meta.url).href : '../../supabase/functions/live-poll/runner.ts')
const { withWorkContext } = await import('../../supabase/functions/_shared/workContext.ts')
const { liveFailureText } = await import('../../supabase/functions/live-poll/fallback.ts')
const q = async operation => { const { data, error } = await operation; if (error) throw new Error(JSON.stringify(error)); return data }
const users = [], league = crypto.randomUUID(), season = crypto.randomUUID(), members = [crypto.randomUUID(), crypto.randomUUID()]
let holder
const results = [], publications = new Map(), failures = []
try {
  try {
    await syncScores(undefined, new Date(businessAt), { recoverStats: false })
    console.log('Restored backup score sync: PASS')
  } catch (error) {
    console.error(liveFailureText(error))
    await Deno.writeTextFile('../score-diagnosis.json', JSON.stringify({ error: liveFailureText(error), operations }, null, 2))
    throw error
  }
  if (Deno.args.includes('--diagnose')) Deno.exit(0)
  businessAt = rounds[0].espnAt
  const changes = recordedPointChanges(records).filter(row => Date.parse(row.changedAt) > businessAt)
  const espnIds = [...new Set(changes.map(row => row.espnId))]
  const identities = await q(supabase.from('players').select('id,espn_id').in('espn_id', espnIds))
  assert.equal(identities.length, espnIds.length, 'The backup must link every measured athlete')
  const games = await q(supabase.from('nba_games').select('id,nba_game_id,week_number').in('nba_game_id', gameIds))
  assert.equal(games.length, 2)
  assert.equal(new Set(games.map(game => game.week_number)).size, 1)
  const week = games[0].week_number
  for (let side = 0; side < 2; side++) {
    const data = await q(supabase.auth.admin.createUser({ email: `live-fallback-${members[side]}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
      user_metadata: { username: `fallback_${members[side].replaceAll('-', '').slice(0, 12)}` } }))
    users.push(data.user.id)
  }
  await q(supabase.from('leagues').insert({ id: league, name: 'Synthetic recorded live fallback', slug: league, commissioner_id: users[0], status: 'active', roster_size: 30, scoring_settings: { points: 1 } }))
  await q(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: 2027, is_current: true }))
  await q(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: users[side], role: side ? 'manager' : 'commissioner', team_name: `Synthetic ${side}` }))))
  await q(supabase.from('lineup_slot_templates').update({ slot_count: 30 }).eq('league_id', league).eq('slot_type', 'UTIL'))
  const players = identities.map((row, index) => ({ ...row, member_id: members[index % 2] }))
  await q(supabase.from('roster_players').insert(players.map(row => ({ player_id: row.id, member_id: row.member_id, league_id: league, league_season_id: season, acquired_via: 'draft', acquired_at: '2026-10-28T12:00:00Z' }))))
  await q(supabase.from('weekly_lineups').insert(players.map(row => ({ player_id: row.id, member_id: row.member_id, league_id: league, league_season_id: season, week_number: week, game_date: '2026-10-29', slot_type: 'UTIL', is_auto_set: false }))))
  await q(supabase.from('matchups').insert({ league_id: league, league_season_id: season, week_number: week, home_member_id: members[0], away_member_id: members[1], matchup_type: 'regular_season', home_points: 0, away_points: 0 }))
  holder = await q(supabase.rpc('try_live_poll_lease', { p_lock_key: 779001, p_ttl_seconds: 90 }))
  assert.ok(holder)
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [businessAt])) }
    static now() { return businessAt }
  }
  const ticks = rounds.map(round => ({ at: round.espnAt, round }))
  if (mode === 'nba') ticks.push(...rounds.map(round => ({ at: round.nbaAt + injectedNbaLagMs, round })))
  for (const { at, round } of ticks.sort((a, b) => a.at - b.at)) {
    scoreboard = round.board
    summaries = new Map(round.summaries.map(row => [row.payload.header.id, row]))
    if (summaries.size !== 2) continue
    businessAt = at
    const callsBefore = { boardCalls, summaryCalls, identityReads }
    const started = performance.now()
    const result = await withWorkContext({ signal: AbortSignal.timeout(18_000), livePollHolder: holder }, () => ingestTick(holder))
    const elapsedMs = performance.now() - started
    assert.equal(result.worked, true, 'Each recorded live tick must ingest its game inputs')
    if (mode === 'espn') assert.equal(boardCalls - callsBefore.boardCalls, 1, 'One ESPN scoreboard per healthy live tick')
    assert.ok(summaryCalls - callsBefore.summaryCalls <= 2)
    assert.ok(identityReads - callsBefore.identityReads <= 1)
    const stored = await q(supabase.from('player_game_stats').select('player_id,game_id,points,did_not_play').in('game_id', games.map(game => game.id)))
    const matchups = await q(supabase.from('matchups').select('*').eq('league_season_id', season))
    const starters = players.flatMap(player => stored.filter(stat => stat.player_id === player.id).map(stat => ({ ...stat, member_id: player.member_id, week_number: week })))
    checkMatchupPoints({ matchups, starters, settings: { points: 1 }, expectedCount: 1 })
    for (const change of changes) {
      if (Date.parse(change.changedAt) > businessAt) continue
      const key = `${change.espnId}:${change.points}`
      const player = players.find(player => player.espn_id === change.espnId)
      const game = games.find(game => game.nba_game_id === (change.gameId === '401909893' ? '0022600144' : '0022600145'))
      if (!publications.has(key) && stored.some(row => row.player_id === player.id && row.game_id === game.id && row.points >= change.points)) publications.set(key, {
        ...change, publicationAt: new NativeDate(businessAt + elapsedMs).toISOString(), lagMs: businessAt + elapsedMs - Date.parse(change.changedAt), elapsedMs,
      })
    }
    results.push({ at: new NativeDate(businessAt).toISOString(), elapsedMs, lines: result.lines, failures: result.failures, home: matchups[0].home_points, away: matchups[0].away_points })
    failures.push(...result.failures)
  }
  const measured = [...publications.values()]
  assert.ok(measured.length >= 3, 'Replay must publish multiple real scoring changes')
  assert.equal(measured.length, changes.length, 'Every recorded scoring change reaches matchup totals')
  let timeoutRecoveryMs = null, espnTimeoutRecoveryMs = null
  if (mode === 'espn') {
    timeout = true
    let started = performance.now()
    const recovered = await withWorkContext({ signal: AbortSignal.timeout(18_000), livePollHolder: holder }, () => ingestTick(holder))
    timeoutRecoveryMs = performance.now() - started
    assert.ok(timeoutRecoveryMs < 10_000, 'A stalled NBA copy leaves time for ESPN and scoring')
    assert.ok(recovered.lines > 0)
    assert.deepEqual(recovered.failures, [])
    timeout = false
    espnTimeout = true
    started = performance.now()
    const fallback = await withWorkContext({ signal: AbortSignal.timeout(18_000), livePollHolder: holder }, () => ingestTick(holder))
    espnTimeoutRecoveryMs = performance.now() - started
    assert.ok(espnTimeoutRecoveryMs < 10_000, 'An ESPN timeout leaves time for NBA fallback and scoring')
    assert.deepEqual(fallback.failures, [])
    espnTimeout = false
  }
  const report = { mode, session: sessionFile, provenance: 'Recorded raw NBA and ESPN payloads; NBA responses released after an injected delay; initial historical NBA copy remains available',
    injectedNbaLagMs, pollIntervalMs: 20_000, ticks: results, samples: measured.length, p95LagMs: percentile95(measured.map(row => row.lagMs)), targetMs: 90_000, publications: measured,
    timeoutRecoveryMs, espnTimeoutRecoveryMs, boardCalls, summaryCalls, identityReads, inputFailures: operations, rejectedSnapshots: failures }
  await Deno.writeTextFile(`../live-fallback-${mode}-result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ mode, samples: report.samples, p95LagMs: report.p95LagMs, targetMet: report.p95LagMs < report.targetMs, timeoutRecoveryMs, espnTimeoutRecoveryMs, ticks: results.length }))
} finally {
  globalThis.Date = NativeDate
  if (holder) await q(supabase.rpc('release_live_poll_lease', { p_lock_key: 779001, p_holder_id: holder }))
  await q(supabase.from('leagues').delete().eq('id', league))
  for (const id of users) await supabase.auth.admin.deleteUser(id)
}
