import { strict as assert } from 'node:assert'

// Real worker, provider parser, and SQL; only provider data is synthetic.
const api = Deno.env.get('SUPABASE_URL')
const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db, 'An isolated local database is required')
assert.ok(['localhost', '127.0.0.1'].includes(new URL(api).hostname))
assert.ok(['localhost', '127.0.0.1'].includes(new URL(db).hostname))
const apiOrigin = new URL(api).origin
const sourceBase = new URL(Deno.env.get('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json')
const nativeFetch = globalThis.fetch.bind(globalThis)
const token = crypto.randomUUID().replaceAll('-', '')
const playerIds = [crypto.randomUUID(), crypto.randomUUID()]
const nbaIds = [0, 1].map((index) => 700000000 + crypto.getRandomValues(new Uint32Array(1))[0] % 90000000 + index)
assert.notEqual(nbaIds[0], nbaIds[1])
type Fixture = { year: number; jobId?: string; openingFails: boolean }
const fixtures: Fixture[] = []
const requests: { year: number; key: string; status: number }[] = []
const rpcCalls: { rpc: string; initialization?: boolean; status: number; code?: string }[] = []
const numeric = ['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal',
  'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points', 'reboundsDefensive',
  'reboundsOffensive', 'reboundsTotal', 'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers']
const key = (year: number, number: number) => `002${String(year - 2001).padStart(2, '0')}0${String(number).padStart(4, '0')}`
const date = (year: number, number: number) => `${year - 1}-10-${number === 1 ? '15' : '23'}`
const payload = (year: number, number: number) => ({ game: {
  gameId: key(year, number), gameStatus: 3, gameEt: `${date(year, number)}T19:00:00`,
  homeTeam: { teamTricode: 'XCH', players: [player(0)] },
  awayTeam: { teamTricode: 'XCA', players: [player(1)] },
} })
function player(index: number) {
  return { personId: nbaIds[index], name: `Synthetic ${token} ${index}`, played: '1',
    statistics: { ...Object.fromEntries(numeric.map((name) => [name, 0])), minutes: 'PT30M00.00S', points: 20 + index } }
}
const schedule = (fixture: Fixture) => ({ leagueSchedule: {
  seasonYear: `${fixture.year - 1}-${String(fixture.year).slice(-2)}`,
  gameDates: [1, 2].map((number) => ({ games: [{
    gameId: key(fixture.year, number), gameDateEst: date(fixture.year, number), gameStatus: 3,
    weekNumber: number, homeTeam: { teamTricode: 'XCH' }, awayTeam: { teamTricode: 'XCA' },
  }] })),
} })
let scheduleFixture: Fixture | undefined
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
  const pathname = new URL(request.url).pathname
  if (pathname.endsWith('/staticData/scheduleLeagueV2_1.json')) {
    assert.ok(scheduleFixture, 'Schedule fixture must be selected before fetching')
    return Response.json(schedule(scheduleFixture))
  }
  const match = /\/liveData\/boxscore\/boxscore_(\d+)\.json$/.exec(pathname)
  assert.ok(match, `Unexpected synthetic provider path: ${pathname}`)
  const fixture = fixtures.find((item) => match[1].startsWith(key(item.year, 1).slice(0, 6)))
  assert.ok(fixture, 'Every requested game must belong to a reserved fixture season')
  const number = Number(match[1].slice(-4))
  assert.ok(number >= 1 && number <= 1300)
  const status = number === 1 && fixture.openingFails ? 503 : number <= 2 ? 200 : 404
  requests.push({ year: fixture.year, key: match[1], status })
  if (status === 503) return new Response('Synthetic opening-game provider outage', { status })
  if (status === 404) return new Response('No such candidate in the synthetic provider season', { status })
  return Response.json(payload(fixture.year, number))
})
const providerOrigin = `http://127.0.0.1:${provider.addr.port}`
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin === sourceBase.origin && url.pathname.startsWith(sourceBase.pathname.replace(/\/$/, '') + '/')) {
    const destination = providerOrigin + url.pathname + url.search
    return await nativeFetch(input instanceof Request ? new Request(destination, input) : destination, init)
  }
  assert.equal(url.origin, apiOrigin, 'Only the isolated Supabase API receives database requests')
  // Observe actual RPC responses, including SQL errors. Never replace them.
  const rpc = url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.split('/').at(-1) : undefined
  const body = init && 'body' in init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  const response = await nativeFetch(input, init)
  if (rpc === 'rebuild_nba_calendar_atomic' || rpc === 'publish_nba_schedule_atomic' || rpc === 'invoke_edge_function') {
    const result = await response.clone().json()
    rpcCalls.push({ rpc, initialization: body?.p_allow_initialization, status: response.status, code: result?.code })
  }
  return response
}

async function sql(statement: string): Promise<string> {
  const process = new Deno.Command('psql', {
    args: [db!, '-X', '-qAt', '--set', 'ON_ERROR_STOP=1'],
    stdin: 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn()
  const writer = process.stdin.getWriter()
  await writer.write(new TextEncoder().encode(`SET statement_timeout='10s'; SET lock_timeout='3s';\n${statement};\n`))
  await writer.close()
  const result = await process.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const q = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
let supabase: any
try {
  ;({ supabase } = await import('../../functions/_shared/supabase.ts'))
  const jobs = await import('../../functions/_shared/backfillJobs.ts')
  const { runCDNEnumChunk } = await import('../../functions/_shared/cdnBackfill.ts')
  const { fetchSeasonSchedule } = await import('../../functions/_shared/nba.ts')
  const { buildScheduleSyncPlan } = await import('../../functions/_shared/schedule.ts')

  const years = Array.from({ length: 99 }, (_, index) => index + 2002)
  for (let index = years.length - 1; index > 0; index--) {
    const other = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1)
    ;[years[index], years[other]] = [years[other], years[index]]
  }
  for (const year of years) {
    const [games, weeks, seasons, existingJobs] = await Promise.all([
      q(supabase.from('nba_games').select('id').or(`season_year.eq.${year},nba_game_id.like.${key(year, 1).slice(0, 6)}%`)),
      q(supabase.from('season_weeks').select('id').eq('season_year', year)),
      q(supabase.from('league_seasons').select('id').eq('season_year', year)),
      q(supabase.from('sync_jobs').select('id').eq('job_type', `backfill_cdn-enum_${year}`)),
    ])
    if (games.length || weeks.length || seasons.length || existingJobs.length) continue
    const revisions = await sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope='calendar:${year}' OR scope LIKE 'nba:${year}:%'`)
    if (revisions !== '0') continue
    fixtures.push({ year, openingFails: true })
    if (fixtures.length === 3) break
  }
  assert.equal(fixtures.length, 3, 'Three unused synthetic seasons are required')
  assert.deepEqual(await q(supabase.from('players').select('id').or(`id.in.(${playerIds.join(',')}),nba_id.in.(${nbaIds.join(',')})`)), [])
  await q(supabase.from('players').insert(playerIds.map((id, index) => ({
    id, nba_id: String(nbaIds[index]), first_name: 'Synthetic', last_name: `${token} ${index}`,
    position: 'PG', eligible_positions: ['PG'], nba_team: 'XCH',
  }))))

  const read = async (fixture: Fixture) => ({
    games: await q(supabase.from('nba_games').select('id,nba_game_id,game_date,week_number,stats_synced_at').eq('season_year', fixture.year).order('nba_game_id')),
    weeks: await q(supabase.from('season_weeks').select('id,week_number,week_start,week_end').eq('season_year', fixture.year).order('week_number')),
    stats: await q(supabase.from('player_game_stats').select('game_id,player_id,season_year,game_date,week_number,points').eq('season_year', fixture.year).order('game_id').order('player_id')),
    attempts: fixture.jobId ? await q(supabase.from('backfill_game_attempts').select('game_key,status,last_error,game_db_id').eq('job_id', fixture.jobId).order('game_key')) : [],
    job: fixture.jobId ? await q(supabase.from('sync_jobs').select('status,completed_items,failed_items,completed_at,metadata,claim_token').eq('id', fixture.jobId).single()) : null,
  })
  const print = (stage: string, fixture: Fixture, state: any, requestStart: number, rpcStart: number) =>
    console.log(JSON.stringify({ stage, seasonYear: fixture.year, state,
      providerRequests: requests.slice(requestStart), realRpcResponses: rpcCalls.slice(rpcStart) }))
  const run = async (fixture: Fixture, retry: boolean) => {
    assert.ok(fixture.jobId)
    const { job, claimToken } = await jobs.claimBackfillJob(fixture.jobId, null)
    const admitted = { ...jobs.backfillJobAuthority(job, {}), jobId: fixture.jobId, claimToken }
    let handedOff = false
    try {
      if (retry) admitted.retryBefore = await jobs.beginBackfillRetry(admitted, job.metadata)
      handedOff = await runCDNEnumChunk(admitted, 0)
      assert.equal(handedOff, false, 'This fixture finishes in one genuine worker chunk')
    } catch (error) {
      // PostgREST errors are plain objects. Preserve their actual message for assertions.
      if (error && typeof error === 'object' && 'message' in error) throw new Error(String(error.message), { cause: error })
      throw error
    } finally {
      if (!handedOff && admitted.retryBefore) await jobs.endBackfillRetry(admitted)
      if (!handedOff) await jobs.releaseBackfillJob(fixture.jobId, claimToken)
    }
  }
  const verifyFirstDiscovery = (fixture: Fixture, start: number) => {
    const observed = requests.slice(start).filter((request) => request.year === fixture.year)
    assert.deepEqual(observed.map((request) => request.key), Array.from({ length: 28 }, (_, index) => key(fixture.year, index + 1)))
    assert.deepEqual(observed.map((request) => request.status), [503, 200, ...Array(26).fill(404)])
    assert.ok(!rpcCalls.some((entry) => entry.rpc === 'invoke_edge_function'), 'No continuation response is fabricated')
  }
  const makePlan = async (fixture: Fixture) => {
    scheduleFixture = fixture
    const raw = await fetchSeasonSchedule()
    assert.equal(raw.length, 2)
    assert.deepEqual(raw.map((game) => game.gameId), [key(fixture.year, 1), key(fixture.year, 2)])
    // Historical fixtures use a matching clock for the actual freshness check.
    const plan = buildScheduleSyncPlan(raw, new Date(`${fixture.year - 1}-10-14T12:00:00Z`))
    assert.equal(plan.seasonYear, fixture.year)
    assert.equal(plan.seasonStart, date(fixture.year, 1))
    assert.equal(plan.offseasonStale, undefined)
    assert.deepEqual(plan.rows.map((row) => row.week_number), [1, 2])
    return plan
  }

  const partial = fixtures[0]
  partial.jobId = await jobs.createBackfillJob('cdn-enum', partial.year)
  let requestStart = requests.length, rpcStart = rpcCalls.length
  assert.deepEqual((await read(partial)).weeks, [])
  await assert.rejects(() => run(partial, false), /Calendar resolution required/i)
  verifyFirstDiscovery(partial, requestStart)
  const first = await read(partial)
  print('first-full-run-with-real-opening-503', partial, first, requestStart, rpcStart)
  assert.equal(first.attempts.filter((row: any) => row.status === 'failed').length, 1)
  assert.equal(first.attempts.filter((row: any) => row.status === 'completed').length, 1)
  assert.equal(first.attempts.filter((row: any) => row.status === 'missing').length, 26)
  assert.match(first.attempts[0].last_error, /CDN 503/)
  assert.equal(first.games.length, 1)
  assert.equal(first.games[0].nba_game_id, key(partial.year, 2))
  assert.equal(first.stats.length, 2)
  assert.deepEqual(first.weeks, [], 'Enumeration must not initialize shared weeks from incomplete discovery')
  assert.equal(first.games[0].week_number, 2, 'Retained stats keep the provisional October-15 estimate')
  assert.ok(first.stats.every((row: any) => row.week_number === 2))
  assert.ok(!rpcCalls.slice(rpcStart).some((entry) => entry.initialization === true), 'No initialization authority is granted to enumeration')
  requestStart = requests.length; rpcStart = rpcCalls.length
  await assert.rejects(() => run(partial, true), /Calendar resolution required/i)
  const repeatedFailure = await read(partial)
  print('repaired-empty-calendar-repeated-opening-503', partial, repeatedFailure, requestStart, rpcStart)
  assert.deepEqual(requests.slice(requestStart), [{ year: partial.year, key: key(partial.year, 1), status: 503 }])
  assert.deepEqual(repeatedFailure.games, first.games)
  assert.deepEqual(repeatedFailure.stats, first.stats)
  assert.deepEqual(repeatedFailure.weeks, [])
  assert.match(repeatedFailure.attempts[0].last_error, /CDN 503/)
  assert.equal(repeatedFailure.job.claim_token, null)
  const completePlan = await makePlan(partial)
  await q(supabase.rpc('publish_nba_schedule_atomic', {
    p_season_year: partial.year, p_games: completePlan.rows, p_weeks: completePlan.weeks,
  }))
  const completeCalendar = await read(partial)
  assert.deepEqual(completeCalendar.games.map((game: any) => game.week_number), [1, 2])
  assert.deepEqual(completeCalendar.weeks.map((week: any) => [week.week_number, week.week_start, week.week_end]), [
    [1, date(partial.year, 1), date(partial.year, 1)], [2, date(partial.year, 2), date(partial.year, 2)],
  ])
  partial.openingFails = false
  requestStart = requests.length; rpcStart = rpcCalls.length
  await run(partial, true)
  const recovered = await read(partial)
  print('repaired-publish-complete-schedule-then-retry-recovers', partial, recovered, requestStart, rpcStart)
  assert.deepEqual(requests.slice(requestStart), [{ year: partial.year, key: key(partial.year, 1), status: 200 }])
  assert.deepEqual(recovered.weeks, completeCalendar.weeks)
  assert.equal(recovered.job.status, 'completed')
  assert.equal(recovered.job.completed_items, 2)
  assert.equal(recovered.job.failed_items, 0)
  assert.deepEqual(recovered.games.map((game: any) => game.week_number), [1, 2])
  assert.equal(recovered.stats.length, 4)
  assert.ok(recovered.games.every((game: any) => game.stats_synced_at))
  for (const game of recovered.games) {
    const stats = recovered.stats.filter((row: any) => row.game_id === game.id)
    assert.equal(stats.length, 2)
    assert.ok(stats.every((row: any) => row.week_number === game.week_number && row.game_date === game.game_date))
  }

  // Zero failed box scores still cannot prove discovery completeness.
  const healthy = fixtures[2]
  healthy.openingFails = false
  healthy.jobId = await jobs.createBackfillJob('cdn-enum', healthy.year)
  requestStart = requests.length; rpcStart = rpcCalls.length
  await assert.rejects(() => run(healthy, false), /Calendar resolution required/i)
  const beforeRetry = await read(healthy)
  assert.deepEqual(beforeRetry.weeks, [])
  assert.deepEqual(requests.slice(requestStart).map((request) => request.status), [200, 200, ...Array(26).fill(404)])
  assert.equal(beforeRetry.attempts.filter((row: any) => row.status === 'failed').length, 0)
  requestStart = requests.length; rpcStart = rpcCalls.length
  await assert.rejects(() => run(healthy, true), /Calendar resolution required/i)
  const emptyRetry = await read(healthy)
  assert.deepEqual(requests.slice(requestStart), [])
  assert.deepEqual(emptyRetry.weeks, [])
  assert.deepEqual(emptyRetry.games, beforeRetry.games)
  assert.deepEqual(emptyRetry.stats, beforeRetry.stats)
  assert.equal(emptyRetry.job.status, 'pending')
  assert.equal(emptyRetry.job.claim_token, null)
  print('successful-discovery-and-empty-retry-cannot-initialize-calendar', healthy, emptyRetry, requestStart, rpcStart)
  const authoritative = await makePlan(healthy)
  await q(supabase.rpc('publish_nba_schedule_atomic', {
    p_season_year: healthy.year, p_games: authoritative.rows, p_weeks: authoritative.weeks,
  }))
  await run(healthy, true)
  const settled = await read(healthy)
  assert.equal(settled.job.status, 'completed')
  assert.equal(settled.job.completed_items, 2)
  assert.equal(settled.job.failed_items, 0)
  assert.deepEqual(settled.games.map((game: any) => game.week_number), [1, 2])
  assert.equal(settled.weeks.length, 2)

  // Positive control: a verified complete schedule is authoritative before discovery.
  const verified = fixtures[1]
  const plan = await makePlan(verified)
  await q(supabase.rpc('publish_nba_schedule_atomic', {
    p_season_year: verified.year, p_games: plan.rows, p_weeks: plan.weeks,
  }))
  const published = await read(verified)
  assert.deepEqual(published.games.map((game: any) => game.week_number), [1, 2])
  verified.jobId = await jobs.createBackfillJob('cdn-enum', verified.year)
  requestStart = requests.length; rpcStart = rpcCalls.length
  await run(verified, false)
  verifyFirstDiscovery(verified, requestStart)
  const verifiedFailure = await read(verified)
  print('verified-complete-calendar-with-opening-503', verified, verifiedFailure, requestStart, rpcStart)
  assert.deepEqual(verifiedFailure.weeks, published.weeks)
  assert.equal(verifiedFailure.job.failed_items, 1)
  assert.equal(verifiedFailure.games[1].week_number, 2)
  assert.ok(verifiedFailure.stats.every((row: any) => row.week_number === 2))
  verified.openingFails = false
  requestStart = requests.length; rpcStart = rpcCalls.length
  await run(verified, true)
  const success = await read(verified)
  print('verified-complete-calendar-allows-provider-recovery', verified, success, requestStart, rpcStart)
  assert.deepEqual(requests.slice(requestStart), [{ year: verified.year, key: key(verified.year, 1), status: 200 }])
  assert.deepEqual(success.weeks, published.weeks)
  assert.equal(success.job.status, 'completed')
  assert.equal(success.job.completed_items, 2)
  assert.equal(success.job.failed_items, 0)
  assert.ok(success.games.every((game: any) => game.stats_synced_at))
  assert.deepEqual(success.games.map((game: any) => game.week_number), [1, 2])
  assert.equal(success.stats.length, 4)
  for (const game of success.games) {
    const stats = success.stats.filter((row: any) => row.game_id === game.id)
    assert.equal(stats.length, 2)
    assert.ok(stats.every((row: any) => row.week_number === game.week_number && row.game_date === game.game_date))
  }
} finally {
  const cleanupErrors: unknown[] = []
  const clean = async (work: () => Promise<unknown>) => { try { await work() } catch (error) { cleanupErrors.push(error) } }
  if (supabase) {
    for (const fixture of fixtures) {
      if (fixture.jobId) {
        await clean(() => q(supabase.from('backfill_game_attempts').delete().eq('job_id', fixture.jobId)))
        await clean(() => q(supabase.from('sync_jobs').delete().eq('id', fixture.jobId)))
      }
      const providerKeys = [key(fixture.year, 1), key(fixture.year, 2)]
      await clean(async () => {
        const games = await q(supabase.from('nba_games').select('id').in('nba_game_id', providerKeys).eq('season_year', fixture.year))
        if (games.length) {
          await q(supabase.from('player_game_stats').delete().in('game_id', games.map((game: any) => game.id)))
          await q(supabase.from('nba_games').delete().in('id', games.map((game: any) => game.id)))
        }
      })
      await clean(() => q(supabase.from('season_weeks').delete().eq('season_year', fixture.year).in('week_number', [1, 2])))
    }
    await clean(() => q(supabase.from('players').delete().in('id', playerIds)))
    const scopes = [...playerIds.map((id) => `player:${id}`), ...fixtures.flatMap((fixture) => [
      `calendar:${fixture.year}`, `nba:${fixture.year}:1`, `nba:${fixture.year}:2`,
    ])]
    await clean(() => sql(`DELETE FROM private.score_input_revisions WHERE scope IN (${scopes.map((scope) => `'${scope}'`).join(',')})`))
    await clean(async () => {
      for (const fixture of fixtures) {
        assert.deepEqual(await q(supabase.from('nba_games').select('id').eq('season_year', fixture.year)), [])
        assert.deepEqual(await q(supabase.from('season_weeks').select('id').eq('season_year', fixture.year)), [])
        if (fixture.jobId) {
          assert.deepEqual(await q(supabase.from('sync_jobs').select('id').eq('id', fixture.jobId)), [])
          assert.deepEqual(await q(supabase.from('backfill_game_attempts').select('id').eq('job_id', fixture.jobId)), [])
        }
      }
      assert.deepEqual(await q(supabase.from('players').select('id').in('id', playerIds)), [])
      assert.equal(await sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${scopes.map((scope) => `'${scope}'`).join(',')})`), '0')
    })
  }
  globalThis.fetch = nativeFetch
  await clean(() => provider.shutdown())
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned fixture cleanup failed')
  console.log(JSON.stringify({ cleanup: 'complete', databaseResponses: 'actual', fixtureSeasons: fixtures.map((fixture) => fixture.year) }))
}
