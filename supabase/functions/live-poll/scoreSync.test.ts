import { strict as assert } from 'node:assert'

const league = '00000000-0000-4000-8000-000000000001'
const season = '00000000-0000-4000-8000-000000000002'
const members = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004']
const players = ['00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006']
let seasonEnded = false
let storedHomePoints = 10
let stale = false
let staleAfterCapture = false
let finalized = true
let missingMax = false
let rejectPublication = false
let certificateReads = 0
let rosterReads = 0
let publications: Record<string, unknown>[] = []
let inputRevision = 1
let liveWriteFailures: { code: string; message: string }[] = []
let livePublications: Record<string, unknown>[] = []
const weeks = [
  { week_number: 1, week_start: '2101-01-01', week_end: '2101-01-07' },
  { week_number: 2, week_start: '2101-01-08', week_end: '2101-01-14' },
]

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
  const url = new URL(request.url)
  const table = url.pathname.split('/').at(-1)
  const select = url.searchParams.get('select') ?? ''
  let body: unknown = []
  if (table === 'league_seasons') {
    body = url.searchParams.has('id') ? { is_current: true } : [
      { id: season, league_id: league, season_year: 2101, is_current: true, leagues: { scoring_settings: { points: 1 } } },
    ]
  } else if (table === 'season_weeks') {
    const week = url.searchParams.get('week_number')
    body = week?.startsWith('eq.') ? weeks.find(row => row.week_number === Number(week.slice(3))) : seasonEnded ? weeks.slice(0, 1) : weeks
  } else if (table === 'leagues') {
    body = { scoring_settings: { points: 1 } }
  } else if (table === 'league_members') {
    body = members.map(id => ({ id }))
  } else if (table === 'matchups') {
    if (!url.searchParams.has('matchup_type') && url.searchParams.get('week_number') !== 'eq.2'
      && (url.searchParams.get('is_finalized') !== 'eq.false' || !finalized)) {
      body = [{ id: 'matchup', league_id: league, league_season_id: season, week_number: 1,
        end_week_number: null, matchup_type: 'regular_season', is_finalized: finalized,
        home_member_id: members[0], away_member_id: members[1], home_points: storedHomePoints, away_points: 8,
        home_max_possible_points: missingMax ? null : 50, away_max_possible_points: 40,
        winner_member_id: members[0] }]
    } else if (select === 'week_number, is_finalized') {
      body = [{ week_number: 1, is_finalized: finalized }]
    }
  } else if (table === 'standings' && select === 'week_number, member_id') {
    body = members.map(member_id => ({ week_number: 1, member_id }))
  } else if (table === 'capture_score_inputs') {
    if (staleAfterCapture) stale = true
    body = { 'season:fixture': String(inputRevision) }
  } else if (table === 'update_score_points_atomic') {
    const payload = await request.json()
    livePublications.push(payload)
    assert.ok(payload.p_matchups.every((row: { input_token: unknown }) =>
      JSON.stringify(row.input_token) === JSON.stringify({ 'season:fixture': String(inputRevision) })))
    const failure = liveWriteFailures.shift()
    if (failure) {
      inputRevision++
      return Response.json(failure, { status: 409 })
    }
  } else if (table === 'get_stale_score_weeks') {
    certificateReads++
    body = stale ? [{ week_number: 1 }] : []
  } else if (table === 'lineup_slot_templates') {
    body = [{ slot_type: 'UTIL', slot_count: 1 }]
  } else if (table === 'roster_players') {
    rosterReads++
    body = members.map((member_id, index) => ({ member_id, player_id: players[index],
      acquired_at: '2100-01-01T00:00:00Z', is_on_ir: false, is_on_taxi: false,
      players: { position: 'PG', eligible_positions: ['PG'] } }))
  } else if (table === 'weekly_lineups') {
    body = members.map((member_id, index) => ({ member_id, player_id: players[index], slot_type: 'UTIL', game_date: '2101-01-03' }))
      .filter(row => url.searchParams.getAll('slot_type').every(filter => !filter.startsWith('neq.') || row.slot_type !== filter.slice(4)))
  } else if (table === 'player_game_stats') {
    body = players.map((player_id, index) => ({ player_id, game_date: '2101-01-03', points: index ? 8 : 9 + inputRevision,
      nba_games: { nba_game_id: '0022100001', game_time: '2101-01-03T23:00:00Z', started_at: null } }))
  } else if (table === 'finalize_score_week_atomic') {
    publications.push(await request.json())
    if (rejectPublication) return new Response(JSON.stringify({ message: 'Score inputs changed or were not certified. Retry scoring.', code: 'PT409' }),
      { status: 409, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { syncScores } = await import('../_shared/syncScores.ts')

function reset() {
  seasonEnded = false
  storedHomePoints = 10
  stale = false
  staleAfterCapture = false
  finalized = true
  missingMax = false
  rejectPublication = false
  certificateReads = 0
  rosterReads = 0
  publications = []
  inputRevision = 1
  liveWriteFailures = []
  livePublications = []
}
const run = () => syncScores(league, new Date('2101-01-10T18:00:00Z'), { recoverStats: false })
const published = () => (publications[0].p_matchups as Record<string, unknown>[])[0]

Deno.test('a certified previous week is absent from the next live scoring plan', async () => {
  reset()
  await run()
  assert.equal(rosterReads, 0)
  assert.equal(certificateReads, 1)
  assert.equal(publications.length, 0)
})

Deno.test('unchanged certified matchups do not call finalization when their week is selected', async () => {
  reset()
  seasonEnded = true
  await run()
  assert.equal(certificateReads, 2)
  assert.equal(rosterReads, 0)
  assert.equal(publications.length, 0)
})

Deno.test('changed actual points still publish even with certified maxima', async () => {
  reset()
  seasonEnded = true
  storedHomePoints = 9
  await run()
  assert.equal(rosterReads, 0)
  assert.equal(published().home_points, 10)
  assert.equal(published().home_max_possible_points, 50)
})

Deno.test('a stale certificate recomputes maxima for corrected inputs', async () => {
  reset()
  stale = true
  await run()
  assert.equal(rosterReads, 1)
  assert.equal(published().home_max_possible_points, 10)
  assert.equal(published().away_max_possible_points, 8)
})

Deno.test('a correction after planning is checked again after input capture', async () => {
  reset()
  seasonEnded = true
  staleAfterCapture = true
  await run()
  assert.equal(certificateReads, 2)
  assert.equal(rosterReads, 1)
  assert.equal(published().home_max_possible_points, 10)
})

Deno.test('missing stored maxima and unfinalized matchups never use the cache', async () => {
  for (const scenario of ['missing', 'unfinalized']) {
    reset()
    seasonEnded = true
    missingMax = scenario === 'missing'
    finalized = scenario !== 'unfinalized'
    await run()
    assert.equal(rosterReads, 1)
    assert.equal(published().home_max_possible_points, 10)
  }
})

Deno.test('a finalized week still ending today recomputes its maximum', async () => {
  reset()
  await syncScores(league, new Date('2101-01-07T18:00:00Z'), { recoverStats: false })
  assert.equal(rosterReads, 1)
  assert.equal(published().home_max_possible_points, 10)
})

Deno.test('cached maxima still pass through the atomic correction-race guard', async () => {
  reset()
  seasonEnded = true
  storedHomePoints = 9
  rejectPublication = true
  await assert.rejects(run, /Score sync failed/)
  assert.equal(rosterReads, 0)
  assert.equal(publications.length, 1)
  assert.deepEqual(published().input_token, { 'season:fixture': '1' })
})

Deno.test('a live publication retry captures and scores fresh inputs once', async () => {
  reset()
  finalized = false
  storedHomePoints = 9
  liveWriteFailures = [{ code: 'PT409', message: 'Score inputs changed or were not certified. Retry scoring.' }]
  let retries = 0
  await syncScores(league, new Date('2101-01-07T18:00:00Z'), {
    recoverStats: false, onPublicationRetry: () => { retries++ },
  })
  assert.equal(retries, 1)
  assert.equal(livePublications.length, 2)
  const rows = livePublications.map(payload => (payload.p_matchups as Record<string, unknown>[])[0])
  assert.deepEqual(rows.map(row => [row.home_points, row.input_token]), [
    [10, { 'season:fixture': '1' }], [11, { 'season:fixture': '2' }],
  ])
})

Deno.test('only the exact stale publication guard permits a retry', async () => {
  for (const failure of [
    { code: 'PT409', message: 'Provider identity changed' },
    { code: '22023', message: 'Score inputs changed or were not certified. Retry scoring.' },
  ]) {
    reset()
    finalized = false
  storedHomePoints = 9
    liveWriteFailures = [failure]
    let retries = 0
    await assert.rejects(() => syncScores(league, new Date('2101-01-07T18:00:00Z'), {
      recoverStats: false, onPublicationRetry: () => { retries++ },
    }), /Score sync failed/)
    assert.equal(retries, 0)
    assert.equal(livePublications.length, 1)
  }
})

Deno.test('a second conflict fails without another retry', async () => {
  reset()
  finalized = false
  storedHomePoints = 9
  liveWriteFailures = Array.from({ length: 2 }, () => ({
    code: 'PT409', message: 'Score inputs changed or were not certified. Retry scoring.',
  }))
  let retries = 0
  await assert.rejects(() => syncScores(league, new Date('2101-01-07T18:00:00Z'), {
    recoverStats: false, onPublicationRetry: () => { retries++ },
  }), /Score sync failed/)
  assert.equal(retries, 1)
  assert.equal(livePublications.length, 2)
})

Deno.test('a caller without retry telemetry captures and scores fresh inputs once', async () => {
  reset()
  finalized = false
  storedHomePoints = 9
  liveWriteFailures = [{ code: 'PT409', message: 'Score inputs changed or were not certified. Retry scoring.' }]
  await syncScores(league, new Date('2101-01-07T18:00:00Z'))
  assert.equal(livePublications.length, 2)
  const rows = livePublications.map(payload => (payload.p_matchups as Record<string, unknown>[])[0])
  assert.deepEqual(rows.map(row => [row.home_points, row.input_token]), [
    [10, { 'season:fixture': '1' }], [11, { 'season:fixture': '2' }],
  ])
})

Deno.test('a second conflict without retry telemetry still fails', async () => {
  reset()
  finalized = false
  storedHomePoints = 9
  liveWriteFailures = Array.from({ length: 2 }, () => ({
    code: 'PT409', message: 'Score inputs changed or were not certified. Retry scoring.',
  }))
  await assert.rejects(() => syncScores(league, new Date('2101-01-07T18:00:00Z')), /Score sync failed/)
  assert.equal(livePublications.length, 2)
})

Deno.test({ name: 'close certificate test server', sanitizeOps: false, sanitizeResources: false, fn: () => postgrest.shutdown() })
