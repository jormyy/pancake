// Actual CDN continuation/retry controls with loopback provider fixtures and a local database.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'

const checkout = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')
const expected = Deno.args.find((arg) => arg.startsWith('--expect='))?.split('=')[1] ?? 'repaired'
const source = Deno.args.find((arg) => arg.startsWith('--source='))?.split('=')[1]
const control = Deno.args.find((arg) => arg.startsWith('--control='))?.split('=')[1] ?? 'retry'
assert.ok(expected === 'baseline' || expected === 'repaired')
assert.ok(source === 'cdn' || source === 'cdn-enum')
assert.ok(control === 'retry' || control === 'continue')
const baseline = expected === 'baseline'
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
  const status = number <= 31 ? 200 : 404
  hits.push({ key: match[1], status })
  if (status === 404) return new Response('No such synthetic candidate', { status })
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
  gameKeys.push(...Array.from({ length: 31 }, (_, index) => key(index + 1)))
  assert.deepEqual(await q(supabase.from('players').select('id').or(`id.in.(${playerIds.join(',')}),nba_id.in.(${nbaIds.join(',')})`)), [])
  assert.equal(await sql.sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${scopes().map(literal).join(',')})`), '0')
  mayClean = true
  await q(supabase.from('players').insert(playerIds.map((id, index) => ({ id, nba_id: String(nbaIds[index]),
    first_name: 'Synthetic', last_name: `${suffix} ${index}`, position: 'PG', eligible_positions: ['PG'], nba_team: index ? 'XCA' : 'XCH' }))))
  const schedule = gameKeys.map((nba_game_id, index) => ({ nba_game_id, season_year: year, game_date: date(index + 1),
    home_team: 'XCH', away_team: 'XCA', status: 'Final', week_number: Math.floor(index / 7) + 1 }))
  const weeks = Array.from({ length: 5 }, (_, index) => ({ season_year: year, week_number: index + 1,
    week_start: date(index * 7 + 1), week_end: date(Math.min(index * 7 + 7, 31)) }))
  // The full synthetic schedule grants calendar authority. Enum cannot invent that authority.
  await q(supabase.rpc('publish_nba_schedule_atomic', { p_season_year: year, p_games: schedule, p_weeks: weeks }))
  jobId = await jobs.createBackfillJob(source, year)
  assert.ok(jobId)
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
  const firstClaim = await jobs.claimBackfillJob(jobId, null)
  const firstRun = { ...jobs.backfillJobAuthority(firstClaim.job, {}), jobId, claimToken: firstClaim.claimToken }
  let firstError: unknown
  const startTime = Date.now()
  try { await worker(firstRun, 0) } catch (error) { firstError = error }
  finally { await jobs.releaseBackfillJob(jobId, firstClaim.claimToken) }
  assert.match(String(firstError), /backfill self-invocation failed:.*Supabase Edge base URL is not configured/)
  assert.ok(Date.now() - startTime >= 6000, 'Keep the thirty actual 200ms delays')
  assert.ok(Date.now() - startTime < 300000, 'Keep the chunk within the actual claim lease')
  const invokes = rpcResponses.filter((entry) => entry.rpc === 'invoke_edge_function')
  assert.equal(invokes.length, 1)
  assert.ok(invokes[0].status >= 400)
  assert.match(invokes[0].message!, /Supabase Edge base URL is not configured/)
  const first = await snapshot()
  assert.equal(first.games.length, 31)
  assert.equal(first.attempts.length, 30)
  assert.ok(first.attempts.every((row: any) => row.status === 'completed'))
  assert.equal(first.stats.length, 60)
  assert.equal(first.games.filter((row: any) => row.stats_synced_at).length, 30)
  assert.equal(first.job.status, 'failed')
  assert.equal(first.job.completed_items, 30)
  assert.equal(first.job.claim_token, null)
  if (source === 'cdn') assert.equal(first.job.total_items, 31)
  const last = first.games.find((row: any) => row.nba_game_id === key(31))
  assert.ok(last && last.stats_synced_at === null)
  assert.ok(!first.attempts.some((row: any) => row.game_key === key(31)))
  assert.ok(!first.stats.some((row: any) => row.game_id === last.id))
  assert.deepEqual(hits, gameKeys.slice(0, 30).map((key) => ({ key, status: 200 })))
  const original = { games: first.games.slice(0, 30), stats: first.stats, attempts: first.attempts }
  const originalHash = hash(original)
  console.log(JSON.stringify({ stage: 'real-continuation-failure', source, completed: 30, requested: 31,
    totalItems: first.job.total_items, preservedHash: originalHash, realRpc: invokes[0] }))

  const hitStart = hits.length
  let continuation = await jobs.claimBackfillJob(jobId, null)
  if (control === 'retry') {
    const admitted = { ...jobs.backfillJobAuthority(continuation.job, {}), jobId, claimToken: continuation.claimToken }
    const cutoff = await jobs.beginBackfillRetry(admitted, continuation.job.metadata)
    const handoff = continuation.claimToken
    // Actual claim transfer and persisted cutoff. Queue delivery is explicitly outside this probe.
    continuation = await jobs.claimBackfillJob(jobId, handoff)
    assert.notEqual(continuation.claimToken, handoff)
    assert.equal(jobs.backfillJobAuthority(continuation.job, {}).retryBefore, cutoff)
  }
  const recoveryRun = { ...jobs.backfillJobAuthority(continuation.job, {}), jobId, claimToken: continuation.claimToken }
  await assert.rejects(() => jobs.claimBackfillJob(jobId!, null), /already running/)
  let handedOff = false
  try {
    handedOff = await worker(recoveryRun, control === 'retry' ? 0 : 30)
    assert.equal(handedOff, false, 'Recovery must finish using the legitimate 26-miss stop for enum')
    if (recoveryRun.retryBefore) await jobs.endBackfillRetry(recoveryRun)
  } finally {
    // Release the owned claim even if an assertion or a second real invocation fails.
    await jobs.releaseBackfillJob(jobId, continuation.claimToken)
  }
  const final = await snapshot()
  const recovers = control === 'continue' || !baseline, complete = recovers ? 31 : 30
  const missing = source === 'cdn-enum' && recovers ? 26 : 0
  const retained = { games: final.games.filter((row: any) => row.id !== last.id),
    stats: final.stats.filter((row: any) => row.game_id !== last.id),
    attempts: final.attempts.filter((row: any) => row.game_key !== key(31) && row.status !== 'missing') }
  assert.deepEqual(retained, original)
  assert.equal(hash(retained), originalHash, 'Every field on the first thirty imports stays exact')
  assert.deepEqual(final.weeks, first.weeks)
  assert.equal(final.attempts.filter((row: any) => row.status === 'completed').length, complete)
  assert.equal(final.attempts.filter((row: any) => row.status === 'missing').length, missing)
  assert.equal(final.attempts.filter((row: any) => row.status === 'failed').length, 0)
  assert.equal(final.stats.length, complete * 2)
  assert.equal(final.games.filter((row: any) => row.stats_synced_at).length, complete)
  assert.equal(final.job.status, 'completed')
  assert.equal(final.job.completed_items, complete)
  assert.equal(final.job.failed_items, 0)
  assert.ok(final.job.completed_at)
  assert.equal(final.job.claim_token, null)
  assert.equal(final.job.metadata.retryBefore, undefined)
  if (source === 'cdn') assert.equal(final.job.total_items, 31)
  else assert.equal(final.job.total_items, first.job.total_items, 'Enum has no requested-game total in this baseline')
  assert.deepEqual(hits.slice(hitStart), recovers ? [{ key: key(31), status: 200 },
    ...(source === 'cdn-enum' ? Array.from({ length: 26 }, (_, index) => ({ key: key(index + 32), status: 404 })) : [])] : [])
  assert.equal(rpcResponses.filter((entry) => entry.rpc === 'invoke_edge_function').length, 1)
  const direct = JSON.parse(await sql.sql(`SELECT jsonb_build_object(
    'marked',(SELECT count(*) FROM public.nba_games WHERE season_year=${year} AND stats_synced_at IS NOT NULL),
    'completed',(SELECT count(*) FROM public.backfill_game_attempts WHERE job_id=${literal(jobId)} AND status='completed'),
    'missing',(SELECT count(*) FROM public.backfill_game_attempts WHERE job_id=${literal(jobId)} AND status='missing'),
    'stats',(SELECT count(*) FROM public.player_game_stats WHERE season_year=${year}))`))
  assert.deepEqual(direct, { marked: complete, completed: complete, missing, stats: complete * 2 })
  console.log(JSON.stringify({ stage: control === 'retry' ? 'helper-equivalent-user-retry' : 'ordinary-offset30-control',
    expected, source, completed: complete, requested: 31, lastUnattempted: !recovers,
    earlier30Hash: hash(retained), earlier30Unchanged: true, recoveryRequests: hits.slice(hitStart), directSql: direct,
    queueDeliveryExercised: false }))
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
    if (jobId) {
      await clean('owned attempts', () => q(supabase.from('backfill_game_attempts').delete().eq('job_id', jobId)))
      await clean('owned job', () => q(supabase.from('sync_jobs').delete().eq('id', jobId)))
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
        ${jobId ? `+ (SELECT count(*) FROM public.sync_jobs WHERE id=${literal(jobId)}) + (SELECT count(*) FROM public.backfill_game_attempts WHERE job_id=${literal(jobId)})` : ''}`), '0')
    })
  }
  globalThis.fetch = nativeFetch
  if (previousProvider === undefined) Deno.env.delete('NBA_CDN_BASE_URL')
  else Deno.env.set('NBA_CDN_BASE_URL', previousProvider)
  await clean('release cooperative reservation', async () => { await sql?.close() })
  await clean('close local provider', () => provider.shutdown())
  console.log(JSON.stringify({ cleanupErrors: errors, execution: 'Actual worker, SQL and loopback provider' }))
  assert.equal(errors.length, 0, 'Owned fixture cleanup must succeed')
}
