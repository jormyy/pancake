// Real local worker, provider statuses, and database. No successful response is fabricated.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'

const checkout = Deno.cwd()
const expected = 'repaired'
const mode = Deno.args.find((arg) => arg.startsWith('--mode='))?.split('=')[1] ?? 'enum403'
assert.ok(['enum403', 'enum404', 'normal403', 'normal503', 'enumBody', 'normalBody'].includes(mode))
const source = mode.startsWith('normal') ? 'cdn' : 'cdn-enum'
const stalledBody = mode.endsWith('Body')
const failedCount = stalledBody ? 1 : 26
const stalledStreams = new Set<ReadableStreamDefaultController<Uint8Array>>()
let restored = false
const api = Deno.env.get('SUPABASE_URL'), db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db, 'Owner must inject isolated local API and SQL settings')
for (const endpoint of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname))
const apiOrigin = new URL(api).origin
const nativeFetch = globalThis.fetch.bind(globalThis)
const playerIds = [crypto.randomUUID(), crypto.randomUUID()]
const nbaIds = [0, 1].map((index) => 700000000 + crypto.getRandomValues(new Uint32Array(1))[0] % 90000000 + index)
assert.notEqual(nbaIds[0], nbaIds[1])
const suffix = crypto.randomUUID().replaceAll('-', '')
const gameKeys: string[] = [], gameIds = new Set<string>(), weekIds = new Set<string>(), weekNumbers = new Set<number>()
let year = 0, jobId: string | null = null, mayClean = false
const jobIds:string[]=[]
const key = (number: number) => `002${String(year - 2001).padStart(2, '0')}0${String(number).padStart(4, '0')}`
const date = (number: number) => new Date(Date.UTC(year - 1, 9, 15 + number - 1)).toISOString().slice(0, 10)
const numeric = ['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal',
  'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points', 'reboundsDefensive',
  'reboundsOffensive', 'reboundsTotal', 'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers']
const player = (index: number) => ({ personId: nbaIds[index], name: `Synthetic ${suffix} ${index}`, played: '1',
  statistics: { ...Object.fromEntries(numeric.map((name) => [name, 0])), minutes: 'PT30M00.00S', points: 20 + index } })
const hits: { key: string; status: number }[] = []
const rpcResponses: { rpc: string; status: number; code?: string; message?: string }[] = []
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
  const match = /^\/liveData\/boxscore\/boxscore_(\d+)\.json$/.exec(new URL(request.url).pathname)
  assert.ok(match && match[1].startsWith(key(1).slice(0, 6)), 'Every provider request belongs to the owned fixture')
  const number = Number(match[1].slice(-4))
  assert.ok(number >= 1 && number <= 1300)
  const blockedStatus = mode.endsWith('503') ? 503 : mode.endsWith('404') ? 404 : 403
  const status = number <= failedCount && !restored && !stalledBody ? blockedStatus : number <= 27 ? 200 : 404
  hits.push({ key: match[1], status })
  if (status !== 200) return new Response('Owned synthetic provider response', { status })
  if (stalledBody && !restored && number === 1) {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stalledStreams.add(controller)
      controller.enqueue(new TextEncoder().encode('{"game":'))
    } }), { headers: { 'Content-Type': 'application/json' } })
  }
  return Response.json({ game: { gameId: match[1], gameStatus: 3, gameEt: `${date(number)}T19:00:00`,
    homeTeam: { teamTricode: 'XCH', players: [player(0)] }, awayTeam: { teamTricode: 'XCA', players: [player(1)] } } })
})
const providerOrigin = `http://127.0.0.1:${provider.addr.port}`
const previousProvider = Deno.env.get('NBA_CDN_BASE_URL')
Deno.env.set('NBA_CDN_BASE_URL', providerOrigin)
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.ok([apiOrigin, providerOrigin].includes(url.origin), 'Remote origins are forbidden')
  const response = await nativeFetch(input, init)
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const bodyText = await response.clone().text(), body = bodyText ? JSON.parse(bodyText) : null
    rpcResponses.push({ rpc: url.pathname.split('/').at(-1)!, status: response.status,
      ...(body?.code ? { code: body.code, message: body.message } : {}) })
  }
  return response
}

class SqlSession {
  process = new Deno.Command('psql', { args: [db!, '-X', '-qAt', '--set', 'ON_ERROR_STOP=1'],
    env: { PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=3000' },
    stdin: 'piped', stdout: 'piped', stderr: 'inherit' }).spawn()
  writer = this.process.stdin.getWriter()
  reader = this.process.stdout.getReader()
  buffer = ''
  async sql(statement: string): Promise<string> {
    const marker = crypto.randomUUID()
    await this.writer.write(new TextEncoder().encode(`${statement}; SELECT '${marker}';\n`))
    let timer: number | undefined
    try {
      return await Promise.race([(async () => {
        while (!this.buffer.includes(marker)) {
          const next = await this.reader.read()
          if (next.done) throw new Error('Own SQL connection closed')
          this.buffer += new TextDecoder().decode(next.value)
        }
        const output = this.buffer.slice(0, this.buffer.indexOf(marker)).trim()
        this.buffer = this.buffer.slice(this.buffer.indexOf(marker) + marker.length)
        return output
      })(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { try { this.process.kill('SIGTERM') } catch {} reject(new Error('Own SQL statement timed out')) }, 15000)
      })])
    } finally { clearTimeout(timer) }
  }
  async close() {
    try { await this.writer.close() } catch {}
    try { await this.reader.cancel() } catch {}
    await this.process.status
  }
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const q = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
let sql: SqlSession | null = null, supabase: any
const scopes = () => [...playerIds.map((id) => `player:${id}`), ...(year ? [
  `calendar:${year}`, ...[...weekNumbers].map((week) => `nba:${year}:${week}`)] : [])]

try {
  sql = new SqlSession()
  ;({ supabase } = await import(`${checkout}/supabase/functions/_shared/supabase.ts`))
  const jobs = await import(`${checkout}/supabase/functions/_shared/backfillJobs.ts`)
  const workers = await import(`${checkout}/supabase/functions/_shared/cdnBackfill.ts`)
  const worker = source === 'cdn' ? workers.runCDNChunk : workers.runCDNEnumChunk
  assert.equal(await sql.sql(`SELECT NULLIF(rtrim(current_setting('app.supabase_url',true),'/'),'') IS NULL`), 't',
    'Require the established missing Edge base URL fixture; never force an RPC error')
  const start = crypto.getRandomValues(new Uint32Array(1))[0] % 99
  for (let offset = 0; offset < 99; offset++) {
    const candidate = 2002 + (start + offset) % 99
    if (await sql.sql(`SELECT pg_try_advisory_lock(hashtext('cdn-retry-fixture'),${candidate})`) !== 't') continue
    const prefix = `002${String(candidate - 2001).padStart(2, '0')}0`
    const available = await sql.sql(`SELECT NOT EXISTS (SELECT 1 FROM public.nba_games WHERE season_year=${candidate} OR nba_game_id LIKE '${prefix}%')
      AND NOT EXISTS (SELECT 1 FROM public.season_weeks WHERE season_year=${candidate})
      AND NOT EXISTS (SELECT 1 FROM public.league_seasons WHERE season_year=${candidate})
      AND NOT EXISTS (SELECT 1 FROM public.sync_jobs WHERE job_type LIKE 'backfill_%_${candidate}')
      AND NOT EXISTS (SELECT 1 FROM private.score_input_revisions WHERE scope='calendar:${candidate}' OR scope LIKE 'nba:${candidate}:%')`)
    if (available === 't') { year = candidate; break }
    await sql.sql(`SELECT pg_advisory_unlock(hashtext('cdn-retry-fixture'),${candidate})`)
  }
  assert.ok(year, 'An empty owned season is required')
  gameKeys.push(...Array.from({ length: 27 }, (_, index) => key(index + 1)))
  assert.deepEqual(await q(supabase.from('players').select('id').or(`id.in.(${playerIds.join(',')}),nba_id.in.(${nbaIds.join(',')})`)), [])
  assert.equal(await sql.sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${scopes().map(literal).join(',')})`), '0')
  mayClean = true
  await q(supabase.from('players').insert(playerIds.map((id, index) => ({ id, nba_id: String(nbaIds[index]),
    first_name: 'Synthetic', last_name: `${suffix} ${index}`, position: 'PG', eligible_positions: ['PG'], nba_team: index ? 'XCA' : 'XCH' }))))
  const schedule = gameKeys.map((nba_game_id) => {
    const number = Number(nba_game_id.slice(-4))
    return { nba_game_id, season_year: year, game_date: date(number), home_team: 'XCH', away_team: 'XCA',
      status: 'Final', week_number: Math.floor((number - 1) / 7) + 1 }
  })
  const weeks = Array.from({ length: 4 }, (_, index) => ({ season_year: year, week_number: index + 1,
    week_start: date(index * 7 + 1), week_end: date(Math.min(index * 7 + 7, 27)) }))
  // The full synthetic schedule grants calendar authority. Enum cannot invent that authority.
  await q(supabase.rpc('publish_nba_schedule_atomic', { p_season_year: year, p_games: schedule, p_weeks: weeks }))
  jobId = await jobs.createBackfillJob(source, year)
  assert.ok(jobId);jobIds.push(jobId)
  const snapshot = async () => {
    const games = await q(supabase.from('nba_games').select('*').eq('season_year', year).order('nba_game_id'))
    const weeks = await q(supabase.from('season_weeks').select('*').eq('season_year', year).order('week_number'))
    for (const game of games) { assert.ok(gameKeys.includes(game.nba_game_id)); gameIds.add(game.id) }
    for (const week of weeks) { weekIds.add(week.id); weekNumbers.add(week.week_number) }
    const stats = gameIds.size ? await q(supabase.from('player_game_stats').select('*').in('game_id', [...gameIds]).order('game_id').order('player_id')) : []
    const attempts = await q(supabase.from('backfill_game_attempts').select('*').eq('job_id', jobId).order('game_key'))
    const job = await q(supabase.from('sync_jobs').select('*').eq('id', jobId).single())
    return { games, weeks, stats, attempts, job }
  }
  const initial = await snapshot()
  assert.equal(initial.games.length, 27)
  assert.equal(initial.stats.length, 0)
  const began = Date.now()
  // These helpers reproduce the worker admission and Retry cutoff/handoff.
  // They do not claim API, Edge handler, or queue transport coverage.
  const invoke = async (retry: boolean) => {
    let claim = await jobs.claimBackfillJob(jobId, null)
    let run = { ...jobs.backfillJobAuthority(claim.job, {}), jobId, claimToken: claim.claimToken }
    if (retry) {
      const cutoff = await jobs.beginBackfillRetry(run, claim.job.metadata)
      claim = await jobs.claimBackfillJob(jobId, claim.claimToken)
      run = { ...jobs.backfillJobAuthority(claim.job, {}), jobId, claimToken: claim.claimToken }
      assert.equal(run.retryBefore, cutoff)
    }
    let error: unknown, handedOff: boolean | undefined
    try {
      handedOff = await worker(run, 0)
      if (!handedOff && run.retryBefore) await jobs.endBackfillRetry(run)
    } catch (caught) { error = caught }
    finally { await jobs.releaseBackfillJob(jobId, claim.claimToken) }
    if (error) assert.match(String(error), /backfill self-invocation failed:.*Supabase Edge base URL is not configured/)
    return { error, handedOff }
  }
  const firstResult = await invoke(false)
  const first = await snapshot()
  const firstHits = [...hits]
  assert.deepEqual(first.weeks, initial.weeks, 'Recorded calendar stays exact')
  if (mode === 'enum404') {
    assert.equal(firstResult.error, undefined)
    assert.equal(firstResult.handedOff, false)
    assert.deepEqual(firstHits, Array.from({ length: 26 }, (_, index) => ({ key: key(index + 1), status: mode === 'enum404' ? 404 : 403 })))
    assert.equal(first.attempts.filter((row: any) => row.status === 'missing').length, 26)
    assert.equal(first.attempts.filter((row: any) => row.status === 'failed').length, 0)
    assert.equal(first.job.status, 'completed')
    assert.equal(first.job.failed_items, 0)
    assert.equal(first.stats.length, 0)
    assert.ok(first.games.every((game: any) => game.stats_synced_at === null))
  } else {
    assert.equal(first.attempts.filter((row: any) => row.status === 'failed').length, failedCount)
    assert.equal(first.attempts.filter((row: any) => row.status === 'completed').length, 27 - failedCount)
    assert.equal(first.stats.length, (27 - failedCount) * 2)
    assert.ok(first.games.find((game: any) => game.nba_game_id === key(27)).stats_synced_at)
    if (source === 'cdn') {
      assert.equal(firstResult.error, undefined)
      assert.equal(first.job.status, 'completed_with_errors')
      assert.equal(firstHits.length, 27)
    } else {
      assert.ok(firstResult.error, 'Thirty enum attempts require the real continuation RPC')
      assert.equal(firstHits.length, 30)
      assert.equal(first.attempts.filter((row: any) => row.status === 'missing').length, 3)
    }
  }
  if (stalledBody) {
    assert.ok(Date.now() - began >= 12000, 'Exercise the real body deadline')
    assert.ok(Date.now() - began < 30000, 'The worker continues after the bounded body failure')
  }
  console.log(JSON.stringify({ stage: 'initial-response-classification', mode, expected,
    requests: firstHits, stats: first.stats.length,
    states: first.attempts.map((row: any) => ({ key: row.game_key, status: row.status })),
    jobStatus: first.job.status, calendarHash: hash(first.weeks) }))
  restored = true
  const requestBoundary = hits.length
  let result = await invoke(true)
  // Retain the original cutoff across real failed-continuation recovery.
  for (let chunk = 0; result.error && chunk < 3; chunk++) result = await invoke(false)
  assert.equal(result.error, undefined, 'The fixture finishes within four retry chunks')
  assert.equal(result.handedOff, false)
  const final = await snapshot()
  assert.deepEqual(final.weeks, initial.weeks)
  assert.equal(final.job.claim_token, null)
  assert.equal(final.job.metadata.retryBefore, undefined)
  assert.equal(final.job.status, 'completed')
  assert.equal(final.job.failed_items, 0)
  const recoveryHits = hits.slice(requestBoundary)
  if (mode === 'enum404') {
    assert.deepEqual(recoveryHits, [], 'A stored missing tail suppresses every restored request')
    assert.deepEqual(final.attempts, first.attempts)
    assert.deepEqual(final.games, first.games)
    assert.equal(final.stats.length, 0)
    assert.equal(final.job.completed_items, 0)
  } else {
    assert.equal(final.job.completed_items, 27)
    assert.equal(final.stats.length, 54)
    assert.equal(final.attempts.filter((row: any) => row.status === 'completed').length, 27)
    assert.ok(final.games.every((game: any) => game.stats_synced_at !== null))
    for (let number = 1; number <= failedCount; number++) assert.equal(recoveryHits.filter((hit) => hit.key === key(number)).length, 1)
    assert.equal(recoveryHits.some((hit) => Number(hit.key.slice(-4)) > failedCount && Number(hit.key.slice(-4)) <= 27), false, 'Successful imports are not replayed')
    const previousGames = new Set(first.games.filter((game: any) => Number(game.nba_game_id.slice(-4)) > failedCount).map((game: any) => game.id))
    assert.deepEqual(final.stats.filter((stat: any) => previousGames.has(stat.game_id)), first.stats)
    if (source === 'cdn-enum') {
      assert.equal(final.attempts.filter((row: any) => row.status === 'missing').length, 26)
      assert.equal(hits.length, failedCount + 27 + 26, 'Failed requests + completed imports + missing tail')
    } else assert.equal(hits.length, failedCount + 27)
  }
  assert.ok(Date.now() - began < 55000, 'Bound the worker phase below 55 seconds')
  console.log(JSON.stringify({ stage: 'explicit-retry-after-restored200', mode, expected,
    requests: recoveryHits, completed: final.job.completed_items, stats: final.stats.length,
    calendarUnchanged: true, queueDeliveryExercised: false, handlerExercised: false }))
  if(mode==='enum404'){
    const previousId=jobId,previousJob=final.job,previousAttempts=final.attempts
    jobId=await jobs.createBackfillJob(source,year);assert.ok(jobId);assert.notEqual(jobId,previousId);jobIds.push(jobId)
    const boundary=hits.length
    let fresh=await invoke(false)
    for(let chunk=0;fresh.error&&chunk<3;chunk++)fresh=await invoke(false)
    assert.equal(fresh.error,undefined);assert.equal(fresh.handedOff,false)
    const imported=await snapshot()
    assert.equal(imported.job.status,'completed');assert.equal(imported.job.completed_items,27);assert.equal(imported.job.failed_items,0);assert.equal(imported.stats.length,54)
    assert.equal(hits.length-boundary,53);assert.deepEqual(imported.weeks,initial.weeks)
    assert.deepEqual(await q(supabase.from('sync_jobs').select('*').eq('id',previousId).single()),previousJob)
    assert.deepEqual(await q(supabase.from('backfill_game_attempts').select('*').eq('job_id',previousId).order('game_key')),previousAttempts)
    console.log(JSON.stringify({stage:'start-new-job-recovers-terminal-missing-history',completed:27,stats:54,actualProviderRequests:53,previousJobAndAttemptsExact:true,limit:'The retained missing rows come from actual404. They have the same stored shape as historical403 rows; no historical403 response is fabricated.'}))
  }


} finally {
  const errors: string[] = []
  const clean = async (label: string, operation: () => Promise<unknown>) => {
    try { await operation() } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (supabase && year && mayClean) {
    await clean('collect owned rows', async () => {
      for (const game of await q(supabase.from('nba_games').select('id,nba_game_id').eq('season_year', year))) {
        assert.ok(gameKeys.includes(game.nba_game_id)); gameIds.add(game.id)
      }
      for (const week of await q(supabase.from('season_weeks').select('id,week_number').eq('season_year', year))) {
        weekIds.add(week.id); weekNumbers.add(week.week_number)
      }
      const revisions = JSON.parse(await sql!.sql(`SELECT COALESCE(jsonb_agg(scope),'[]'::jsonb) FROM private.score_input_revisions WHERE scope LIKE 'nba:${year}:%'`))
      for (const scope of revisions) { assert.match(scope, new RegExp(`^nba:${year}:\\d+$`)); weekNumbers.add(Number(scope.split(':')[2])) }
    })
    for(const ownedJobId of jobIds) {
      await clean('owned attempts', () => q(supabase.from('backfill_game_attempts').delete().eq('job_id', ownedJobId)))
      await clean('owned job', () => q(supabase.from('sync_jobs').delete().eq('id', ownedJobId)))
    }
    for (const id of gameIds) {
      await clean('owned stats', () => q(supabase.from('player_game_stats').delete().eq('game_id', id)))
      await clean('owned game', () => q(supabase.from('nba_games').delete().eq('id', id)))
    }
    for (const id of weekIds) await clean('owned week', () => q(supabase.from('season_weeks').delete().eq('id', id)))
    await clean('owned players', () => q(supabase.from('players').delete().in('id', playerIds)))
    await clean('owned revisions after source deletes', () => sql!.sql(`DELETE FROM private.score_input_revisions WHERE scope IN (${scopes().map(literal).join(',')})`))
    await clean('direct zero-leftover check', async () => {
      assert.equal(await sql!.sql(`SELECT (SELECT count(*) FROM public.players WHERE id IN (${playerIds.map(literal).join(',')}))
        + (SELECT count(*) FROM public.nba_games WHERE season_year=${year})
        + (SELECT count(*) FROM public.season_weeks WHERE season_year=${year})
        + (SELECT count(*) FROM public.player_game_stats WHERE season_year=${year})
        + (SELECT count(*) FROM private.score_input_revisions WHERE scope='calendar:${year}' OR scope LIKE 'nba:${year}:%' OR scope IN (${playerIds.map((id) => literal(`player:${id}`)).join(',')}))
        ${jobIds.length ? `+ (SELECT count(*) FROM public.sync_jobs WHERE id IN(${jobIds.map(literal).join(',')})) + (SELECT count(*) FROM public.backfill_game_attempts WHERE job_id IN(${jobIds.map(literal).join(',')}))` : ''}`), '0')
    })
  }
  globalThis.fetch = nativeFetch
  if (previousProvider === undefined) Deno.env.delete('NBA_CDN_BASE_URL')
  else Deno.env.set('NBA_CDN_BASE_URL', previousProvider)
  await clean('release cooperative reservation', async () => { await sql?.close() })
  for (const stream of stalledStreams) { try { stream.close() } catch { /* The body may already be aborted. */ } }
  await clean('close local provider', () => provider.shutdown())
  console.log(JSON.stringify({ cleanupErrors: errors, execution: 'Actual isolated local worker and database'  }))
  assert.equal(errors.length, 0, 'Owned fixture cleanup must succeed')
}
