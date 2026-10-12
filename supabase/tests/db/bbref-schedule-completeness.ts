// Real schedule discovery and failed initialization recovery through the worker and local database.
import { strict as assert } from 'node:assert'

const source = (file: string) => new URL(`../../functions/_shared/${file}.ts`, import.meta.url).href
const api = Deno.env.get('SUPABASE_URL')
const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db, 'Owner must inject local API and SQL settings')
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const databaseOrigin = new URL(api).origin
const ownPlayerIds = [crypto.randomUUID(), crypto.randomUUID()]
const seedId = crypto.randomUUID()
const suffix = crypto.randomUUID().replaceAll('-', '')
const names = [`Synthetic Home${suffix}`, `Synthetic Away${suffix}`]
let year = 0
let ownJobId: string | null = null
let claimedYear = false
let mayCleanRevisions = false
const ownWeekIds = new Set<string>()
const ownWeekNumbers = new Set<number>()
const ownGameIds = new Set<string>()
let mode: 'required-404' | 'healthy' = 'required-404'
const requests: string[] = []
const publications: { status: number; body: any }[] = []
const keys: Record<string, string> = {}
const row = (key: string) => `<tr><td data-stat="box_score_text"><a href="/boxscores/${key}.html">Box Score</a></td>` +
  `<td data-stat="visitor_team_name"><a href="/teams/NYK/${year}.html">New York</a></td></tr>`
const schedule = (rows: string) => `<table id="schedule"><tbody>${rows}</tbody></table>`
const divider = '<tr class="thead"><th>Playoffs</th></tr>'
const columns = {
  mp: '20:00', pts: '12', trb: '4', orb: '1', drb: '3', ast: '2', stl: '1',
  blk: '0', tov: '1', pf: '2', fg: '5', fga: '9', fg3: '1', fg3a: '3',
  ft: '1', fta: '2', plus_minus: '+3',
}
const statsTable = (team: string, name: string) => `<table id="box-${team}-game-basic"><tbody><tr>` +
  `<th data-stat="player"><a href="/players/local.html">${name}</a></th>` +
  Object.entries(columns).map(([key, value]) => `<td data-stat="${key}">${value}</td>`).join('') +
  '</tr></tbody><tfoot><tr><th data-stat="player">Team Totals</th>' +
    Object.entries(columns).map(([key, value]) => `<td data-stat="${key}">${key === 'mp' ? '20' : value}</td>`).join('') +
    '</tr></tfoot></table>'
const htmlResponse = (html: string) => new Response(html, { headers: { 'Content-Type': 'text/html' } })
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
  const path = new URL(request.url).pathname
  requests.push(path)
  const prefix = `/leagues/NBA_${year}_games`
  if (path === `${prefix}.html`) return htmlResponse('<div class="filter">' +
    ['august', 'november', 'december', 'january'].map((month) =>
      `<a href="${prefix}-${month}.html">${month}</a>`).join('') +
    // Duplicate links are harmless. Wrong-season and foreign links are not authority.
    `<a href="${prefix}-august.html">August again</a>` +
    `<a href="/leagues/NBA_${year + 1}_games-march.html">Wrong year</a>` +
    `<a href="https://example.invalid${prefix}-february.html">Foreign</a></div>`)
  if (path === `${prefix}-august.html`) return htmlResponse(schedule(row(keys.august)))
  if (path === `${prefix}-november.html`) {
    if (mode === 'required-404') return new Response('Advertised month unavailable', { status: 404 })
    return htmlResponse(schedule(row(keys.november)))
  }
  if (path === `${prefix}-december.html`) return htmlResponse(schedule(row(keys.december) + divider + row(keys.postDecember)))
  if (path === `${prefix}-january.html`) return htmlResponse(schedule(row(keys.postJanuary)))
  // A missing opening month is legitimate. The season index does not advertise it.
  if (['october', 'february', 'march', 'april', 'may', 'june'].some((month) => path === `${prefix}-${month}.html`)) {
    return new Response('Not a schedule month for this season', { status: 404 })
  }
  if (Object.values(keys).some((key) => path === `/boxscores/${key}.html`)) {
    assert.ok([keys.august, keys.november, keys.december].some((key) => path === `/boxscores/${key}.html`),
      'The worker must never request a postseason box score')
    return htmlResponse(statsTable('BOS', names[0]) + statsTable('NYK', names[1]))
  }
  return new Response('Unexpected fixture path', { status: 500 })
})
const origin = `http://127.0.0.1:${provider.addr.port}`
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin === 'https://www.basketball-reference.com') {
    assert.ok(url.pathname.startsWith(`/leagues/NBA_${year}_games`) ||
      Object.values(keys).some((key) => url.pathname === `/boxscores/${key}.html`))
    return nativeFetch(`${origin}${url.pathname}${url.search}`, init)
  }
  assert.ok([databaseOrigin, origin].includes(url.origin), 'Remote requests are forbidden')
  const response = await nativeFetch(input, init)
  if (url.pathname === '/rest/v1/rpc/publish_nba_schedule_atomic') {
    assert.equal(init?.method, 'POST')
    assert.equal(typeof init?.body, 'string')
    publications.push({ status: response.status, body: JSON.parse(init!.body as string) })
  }
  return response
}

// Keep the cooperative year reservation until every owned row and revision is removed.
class SqlSession {
  process = new Deno.Command('psql', {
    args: [db!, '-X', '-qAt', '--set', 'ON_ERROR_STOP=1'],
    env: { PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=3000' },
    stdin: 'piped', stdout: 'piped', stderr: 'inherit',
  }).spawn()
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
let sql: SqlSession | null = null
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const revisionScopes = () => [
  ...ownPlayerIds.map((id) => `player:${id}`),
  ...(claimedYear ? [`calendar:${year}`, ...[...ownWeekNumbers].map((week) => `nba:${year}:${week}`)] : []),
]

try {
  sql = new SqlSession()
  const { supabase } = await import(source('supabase'))
  const jobs = await import(source('backfillJobs'))
  const { runBBRefChunk } = await import(source('bbrefBackfill'))
  const q = async (operation: any): Promise<any> => {
    const { data, error } = await operation
    if (error) throw new Error(error.message)
    return data
  }
  const calendar = async () => {
    const games = await q(supabase.from('nba_games').select('*').eq('season_year', year).order('nba_game_id'))
    const weeks = await q(supabase.from('season_weeks').select('*').eq('season_year', year).order('week_number'))
    for (const week of weeks) { ownWeekIds.add(week.id); ownWeekNumbers.add(week.week_number) }
    for (const game of games) if (Object.values(keys).includes(game.nba_game_id)) ownGameIds.add(game.id)
    return { games, weeks }
  }
  try {
    const start = crypto.getRandomValues(new Uint32Array(1))[0] % 100
    for (let offset = 0; offset < 100; offset++) {
      const candidate = 1800 + (start + offset) % 100
      if (await sql.sql(`SELECT pg_try_advisory_lock(hashtext('bbref-partial-fixture'),${candidate})`) !== 't') continue
      const available = await sql.sql(`SELECT NOT EXISTS (SELECT 1 FROM public.nba_games WHERE season_year=${candidate})
        AND NOT EXISTS (SELECT 1 FROM public.season_weeks WHERE season_year=${candidate})
        AND NOT EXISTS (SELECT 1 FROM public.league_seasons WHERE season_year=${candidate})
        AND NOT EXISTS (SELECT 1 FROM public.sync_jobs WHERE job_type LIKE 'backfill_%_${candidate}')
        AND NOT EXISTS (SELECT 1 FROM private.score_input_revisions WHERE scope='calendar:${candidate}' OR scope LIKE 'nba:${candidate}:%')`)
      if (available === 't') { year = candidate; break }
      await sql.sql(`SELECT pg_advisory_unlock(hashtext('bbref-partial-fixture'),${candidate})`)
    }
    assert.ok(year, 'An unused synthetic season is required')
    Object.assign(keys, {
      august: `${year - 1}08050BOS`, november: `${year - 1}11050BOS`,
      december: `${year - 1}12050BOS`, postDecember: `${year - 1}12060BOS`,
      postJanuary: `${year}01050BOS`, seed: `${year - 1}08060LAL`,
    })
    claimedYear = true
    assert.equal(await sql.sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${revisionScopes().map(literal).join(',')})`), '0')
    assert.deepEqual(await q(supabase.from('players').select('id').in('id', ownPlayerIds)), [])
    mayCleanRevisions = true
    await q(supabase.from('players').insert(ownPlayerIds.map((id, index) => ({
      id, first_name: 'Synthetic', last_name: `${index ? 'Away' : 'Home'}${suffix}`,
      position: 'PG', eligible_positions: ['PG'], nba_team: index ? 'NYK' : 'BOS', years_exp: 2,
    }))))
    await q(supabase.from('nba_games').insert({
      id: seedId, nba_game_id: keys.seed, season_year: year, game_date: `${year - 1}-08-06`,
      home_team: 'LAL', away_team: 'NYK', status: 'Final', week_number: 1,
      // No BBRef codes: this preserved calendar row must not join the box-score work.
    }))
    await q(supabase.from('season_weeks').insert({
      season_year: year, week_number: 1, week_start: `${year - 1}-08-05`, week_end: `${year - 1}-08-11`,
    }))
    ownJobId = await jobs.createBackfillJob('bbref', year)
    const before = await calendar()
    const run = async (userRetry = false) => {
      let { job, claimToken } = await jobs.claimBackfillJob(ownJobId!, null)
      if (userRetry) {
        const admission = { ...jobs.backfillJobAuthority(job, {}), jobId: ownJobId!, claimToken }
        const cutoff = await jobs.beginBackfillRetry(admission, job.metadata)
        const queuedClaim = claimToken
        // Exact helper-level queue handoff: the continuation replaces the held claim.
        // We do not call invokeBackfill: a separate edge process cannot share this HTTP interception.
        const continuation = await jobs.claimBackfillJob(ownJobId!, queuedClaim)
        job = continuation.job
        claimToken = continuation.claimToken
        assert.notEqual(claimToken, queuedClaim)
        const authority = jobs.backfillJobAuthority(job, {})
        assert.equal(authority.retryBefore, cutoff, 'The continuation must reload the stored cutoff')
        await assert.rejects(() => jobs.claimBackfillJob(ownJobId!, null), /already running/)
      }
      const admitted = { ...jobs.backfillJobAuthority(job, {}), jobId: ownJobId!, claimToken }
      assert.equal(Boolean(admitted.retryBefore), userRetry)
      try {
        assert.equal(await runBBRefChunk(admitted, 0), false)
        if (admitted.retryBefore) await jobs.endBackfillRetry(admitted)
        return null
      } catch (error) {
        // This reproduces the edge function's job-level failure handling.
        await jobs.failBackfillJob(ownJobId!, error)
        return error
      } finally {
        await jobs.releaseBackfillJob(ownJobId!, claimToken)
      }
    }
    const firstError = await run()
    const afterMissing = await calendar()
    const firstJob = await q(supabase.from('sync_jobs').select('*').eq('id', ownJobId).single())
    {
      assert.ok(firstError, 'An advertised month failure must stop initialization')
      assert.match(String(firstError), /404/)
      assert.match(String(firstError), /november/i)
      assert.equal(publications.length, 0, 'No publication RPC may start before schedule completeness is established')
      assert.deepEqual(afterMissing, before, 'Every existing game and week field must remain unchanged')
      assert.equal(firstJob.status, 'failed')
      assert.equal(firstJob.completed_items, 0)
      assert.equal(firstJob.claim_token, null)
      const firstAttempts = await q(supabase.from('backfill_game_attempts').select('*').eq('job_id', ownJobId))
      assert.equal(firstAttempts.length, 0)
      console.log(JSON.stringify({ required404: 'fails before publication', existingCalendarUnchanged: true }))

      mode = 'healthy'
      const requestStart = requests.length
      // User Retry path: begin retry, transfer claim, reload cutoff, then continue at offset zero.
      assert.equal(await run(true), null)
      const afterHealthy = await calendar()
      {
      assert.equal(publications.length, 1)
      assert.equal(publications[0].status, 200)
      const expectedKeys = [keys.august, keys.november, keys.december]
      assert.deepEqual(new Set(publications[0].body.p_games.map((game: any) => game.nba_game_id)), new Set(expectedKeys))
      assert.deepEqual(new Set(afterHealthy.games.map((game: any) => game.nba_game_id)), new Set([...expectedKeys, keys.seed]))
      assert.deepEqual(afterHealthy.games.find((game: any) => game.id === seedId), before.games[0])
      assert.deepEqual(afterHealthy.weeks.find((week: any) => week.week_number === 1), before.weeks[0])
      const allNewRequests = requests.slice(requestStart)
      const monthPaths = ['august', 'november', 'december', 'january'].map((month) => `/leagues/NBA_${year}_games-${month}.html`)
      assert.ok(allNewRequests.includes(`/leagues/NBA_${year}_games.html`))
      for (const path of monthPaths) assert.equal(allNewRequests.filter((value) => value === path).length, 1)
      assert.ok(!allNewRequests.includes(`/leagues/NBA_${year}_games-october.html`), 'Do not guess absent opening months')
      assert.equal(allNewRequests.filter((path) => path.startsWith('/boxscores/')).length, 3)
      const attempts = await q(supabase.from('backfill_game_attempts').select('*').eq('job_id', ownJobId))
      assert.deepEqual(new Set(attempts.map((attempt: any) => attempt.game_key)), new Set(expectedKeys))
      assert.ok(attempts.every((attempt: any) => attempt.status === 'completed'))
      const finalJob = await q(supabase.from('sync_jobs').select('*').eq('id', ownJobId).single())
      assert.equal(finalJob.status, 'completed')
      assert.equal(finalJob.completed_items, 3)
      assert.equal(finalJob.failed_items, 0)
      assert.equal(finalJob.claim_token, null)
      assert.equal(finalJob.metadata.phase, 'boxscores', 'Retry cleanup must retain the freshly completed initialization phase')
      assert.equal(finalJob.metadata.retryBefore, undefined)
      assert.equal(finalJob.metadata.bbrefRetryScope, undefined, 'Retry cleanup must remove the initialization retry scope')
      for (const game of afterHealthy.games.filter((game: any) => expectedKeys.includes(game.nba_game_id))) {
        assert.ok(game.stats_synced_at)
        const stats = await q(supabase.from('player_game_stats').select('player_id,points').eq('game_id', game.id))
        assert.deepEqual(new Set(stats.map((stat: any) => stat.player_id)), new Set(ownPlayerIds))
        assert.ok(stats.every((stat: any) => stat.points === 12))
        const coveringWeeks = afterHealthy.weeks.filter((week: any) => week.week_number === game.week_number &&
          week.week_start <= game.game_date && game.game_date <= week.week_end)
        assert.equal(coveringWeeks.length, 1)
      }
      console.log(JSON.stringify({ healthyUserRetryAfterInitializationFailure: 'complete', regularGames: 3,
        regularAugustIncluded: true, postseasonGamesExcluded: true, existingCalendarPreserved: true,
        allAdvertisedMonthPagesFetched: true }))
      }
    }
  } finally {
    const errors: string[] = []
    const clean = async (label: string, operation: () => Promise<unknown>) => {
      try { await operation() } catch { errors.push(label) }
    }
    if (ownJobId) {
      await clean('own attempts', () => q(supabase.from('backfill_game_attempts').delete().eq('job_id', ownJobId)))
      await clean('own job', () => q(supabase.from('sync_jobs').delete().eq('id', ownJobId)))
    }
    if (claimedYear) {
      // Collect all created calendar rows before deletes. Publication may fill intermediate weeks.
      await clean('recover owned calendar IDs and scopes', async () => {
        await calendar()
        const rows = JSON.parse(await sql!.sql(`SELECT COALESCE(jsonb_agg(scope),'[]'::jsonb)
          FROM private.score_input_revisions WHERE scope LIKE 'nba:${year}:%'`))
        for (const scope of rows) {
          assert.match(scope, new RegExp(`^nba:${year}:\\d+$`))
          ownWeekNumbers.add(Number(scope.split(':')[2]))
        }
      })
      await clean('own games', async () => {
        const games = await q(supabase.from('nba_games').select('id,nba_game_id').eq('season_year', year))
        const owned = games.filter((game: any) => Object.values(keys).includes(game.nba_game_id))
        for (const game of owned) {
          ownGameIds.add(game.id)
          await q(supabase.from('player_game_stats').delete().eq('game_id', game.id))
          await q(supabase.from('nba_games').delete().eq('id', game.id))
        }
      })
      await clean('own weeks', async () => {
        for (const id of ownWeekIds) {
          await q(supabase.from('season_weeks').delete().eq('id', id))
        }
      })
    }
    if (mayCleanRevisions) await clean('own players', () => q(supabase.from('players').delete().in('id', ownPlayerIds)))
    if (mayCleanRevisions) {
      // Delete trigger-produced revisions last, using only exact scopes proven absent before the run.
      await clean('own revisions', () => sql!.sql(`DELETE FROM private.score_input_revisions WHERE scope IN (${revisionScopes().map(literal).join(',')})`))
      await clean('verify revisions absent', async () => {
        assert.equal(await sql!.sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${revisionScopes().map(literal).join(',')})`), '0')
      })
      await clean('verify owned rows absent', async () => {
        assert.equal(await sql!.sql(`SELECT
          (SELECT count(*) FROM public.players WHERE id IN (${ownPlayerIds.map(literal).join(',')}))
          ${claimedYear ? `+ (SELECT count(*) FROM public.nba_games WHERE season_year=${year})
          + (SELECT count(*) FROM public.season_weeks WHERE season_year=${year})
          + (SELECT count(*) FROM private.score_input_revisions WHERE scope='calendar:${year}' OR scope LIKE 'nba:${year}:%')` : ''}
          ${ownGameIds.size ? `+ (SELECT count(*) FROM public.player_game_stats WHERE game_id IN (${[...ownGameIds].map(literal).join(',')}))` : ''}
          ${ownJobId ? `+ (SELECT count(*) FROM public.sync_jobs WHERE id=${literal(ownJobId)})
          + (SELECT count(*) FROM public.backfill_game_attempts WHERE job_id=${literal(ownJobId)})` : ''}`), '0')
      })
    }
    console.log(JSON.stringify({ cleanupErrors: errors, executionLimit: 'Synthetic historical HTML; local real SQL; no external provider access' }))
    assert.equal(errors.length, 0, 'Owned fixture cleanup must succeed')
  }
} finally {
  globalThis.fetch = nativeFetch
  try { await sql?.close() } finally { await provider.shutdown() }
}
