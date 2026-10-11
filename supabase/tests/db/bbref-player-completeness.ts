import { strict as assert } from 'node:assert'

// Real importer, scoring, and PostgreSQL checks with synthetic local provider HTML.
const expectArg = 'repaired'
const caseArg = Deno.args.find((arg) => arg.startsWith('--case='))?.split('=')[1] ?? 'unlinked'
assert.ok(['unlinked', 'unnamed', 'missing-minutes', 'omitted-row', 'malformed-minutes', 'omitted-short-player', 'excess-turnovers', 'negative-counts'].includes(caseArg))
const shortAppearance = caseArg === 'omitted-short-player'
const homeScore = shortAppearance ? 1 : 30
const awayScore = shortAppearance ? 4 : 12
const scoreColumn = shortAppearance ? 'rebounds' : 'points'
const repairedFirstComplete = caseArg === 'unlinked'
const firstHasMarker = repairedFirstComplete
const source = (file: string) => new URL(`../../functions/_shared/${file}.ts`, import.meta.url).href
const api = Deno.env.get('SUPABASE_URL')
const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db, 'Owner must inject local API and SQL settings')
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const apiOrigin = new URL(api).origin
const suffix = crypto.randomUUID().replaceAll('-', '')
const playerIds = Array.from({ length: 3 }, () => crypto.randomUUID())
// Player zero is the omitted scoring contributor. Other players keep both tables nonempty.
const names = ['Starter', 'Home', 'Away'].map((role) => `Synthetic ${role}${suffix}`)
const leagueId = crypto.randomUUID(), leagueSeasonId = crypto.randomUUID()
const memberIds = Array.from({ length: 4 }, () => crypto.randomUUID())
const userIds: string[] = [], ownJobIds: string[] = [], ownWeekIds: string[] = []
let seasonYear = 0, gameKey = '', gameDbId: string | undefined, jobId = ''
let ownsLeague = false, ownsPlayers = false, ownsSeason = false, mayCleanRevisions = false
let mode: string = caseArg
let scheduleHits = 0, boxHits = 0
const realRpcResponses: any[] = []
const columns = {
  mp: '20:00', pts: '12', trb: '4', orb: '1', drb: '3', ast: '2', stl: '1',
  blk: '0', tov: '1', pf: '2', fg: '5', fga: '9', fg3: '1', fg3a: '3',
  ft: '1', fta: '2', plus_minus: '+3',
}
const cells = (values: Record<string, string>) => Object.entries(values)
  .map(([key, value]) => `<td data-stat="${key}">${value}</td>`).join('')
function values(index: number): Record<string, string> {
  if (shortAppearance && index === 0) {
    return { ...Object.fromEntries(Object.keys(columns).map((key) => [key, '0'])),
      mp: '0:10', trb: '1', drb: '1', tov: '1' }
  }
  return { ...columns, ...(shortAppearance && index === 1 ? { mp: '19:50' } : {}),
    ...(!shortAppearance && index === 0 ? { pts: '30', fg: '12', fga: '20', ft: '5', fta: '6' } : {}) }
}
function row(index: number) {
  if (index === 0 && (mode === 'omitted-row' || mode === 'omitted-short-player')) return ''
  const linked = `<a href="/players/local${index}.html">${names[index]}</a>`
  const identity = index === 0 && mode === 'unlinked' ? names[index]
    : index === 0 && mode === 'unnamed' ? '' : linked
  if (index === 0 && mode === 'dnp') {
    return `<tr><th data-stat="player">${identity}</th><td data-stat="reason">Did Not Play</td></tr>`
  }
  return `<tr><th data-stat="player">${identity}</th>` +
    cells({ ...values(index), ...(mode === 'negative-counts' && index < 2 ? { pts: index === 0 ? '-30' : '72' } : {}), ...(index === 0 && mode === 'missing-minutes' ? { mp: '' }
      : index === 0 && mode === 'malformed-minutes' ? { mp: '20garbage:00' }
      : index === 0 && mode === 'excess-turnovers' ? { tov: '100' } : {}) }) + '</tr>'
}
function table(team: string, indices: number[]) {
  const totalValues = Object.fromEntries(Object.keys(columns).map((key) => {
    const sum = indices.reduce((sum, index) => {
      if (index === 0 && mode === 'dnp') return sum
      const raw = values(index)[key]
      if (key === 'mp') {
        const [minutes, seconds] = raw.split(':').map(Number)
        return sum + minutes * 60 + seconds
      }
      return sum + Number(raw)
    }, 0)
    return [key, key === 'mp' ? (sum % 60 === 0 ? String(sum / 60)
      : `${Math.floor(sum / 60)}:${String(sum % 60).padStart(2, '0')}`) : String(sum)]
  }))
  return `<table id="box-${team}-game-basic"><tbody>` +
    '<tr class="thead"><th data-stat="player">Reserves</th></tr>' +
    indices.map(row).join('') +
    // Explicit nonplayer controls: body totals, linked totals, and footer totals.
    '<tr><th data-stat="player">Team Totals</th></tr>' +
    '<tr><th data-stat="player"><a>Team Totals</a></th></tr>' +
    '</tbody><tfoot><tr><th data-stat="player">Team Totals</th>' +
    cells(totalValues) + '</tr></tfoot></table>'
}
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
  const path = new URL(request.url).pathname
  if (path === `/leagues/NBA_${seasonYear}_games.html`) {
    return new Response(`<a href="/leagues/NBA_${seasonYear}_games-october.html">October</a>`)
  }
  if (path === `/leagues/NBA_${seasonYear}_games-october.html`) {
    scheduleHits++
    return new Response('<table id="schedule"><tbody>' +
      `<tr><td data-stat="box_score_text"><a href="/boxscores/${gameKey}.html">Box Score</a></td>` +
      `<td data-stat="visitor_team_name"><a href="/teams/NYK/${seasonYear}.html">New York</a></td></tr>` +
      '<tr class="thead"><th>Playoffs</th></tr></tbody></table>')
  }
  if (path === `/boxscores/${gameKey}.html`) {
    boxHits++
    return new Response(table('BOS', [0, 1]) + table('NYK', [2]),
      { headers: { 'Content-Type': 'text/html' } })
  }
  return new Response('Fixture path forbidden', { status: 404 })
})
const providerOrigin = `http://127.0.0.1:${provider.addr.port}`
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin === 'https://www.basketball-reference.com') {
    assert.ok([
      `/leagues/NBA_${seasonYear}_games.html`, `/leagues/NBA_${seasonYear}_games-october.html`, `/boxscores/${gameKey}.html`,
    ].includes(url.pathname), 'Only owned provider paths are allowed')
    const destination = `${providerOrigin}${url.pathname}${url.search}`
    return nativeFetch(input instanceof Request ? new Request(destination, input) : destination, init)
  }
  assert.ok([apiOrigin, providerOrigin].includes(url.origin), 'External origin forbidden')
  const response = await nativeFetch(input, init)
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const raw = await response.clone().text()
    const body = raw ? JSON.parse(raw) : null
    realRpcResponses.push({ rpc: url.pathname.split('/').at(-1), status: response.status,
      ...(body?.code ? { code: body.code, message: body.message } : {}) })
  }
  return response
}

// Keep one real SQL connection so a cooperative fixture lock spans the run.
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
const sql = new SqlSession()
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const q = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
let supabase: any
const scopes = () => [
  ...playerIds.map((id) => `player:${id}`), `league:${leagueId}`, `season:${leagueSeasonId}`,
  ...[1, 2, 3].flatMap((week) => [`lineup:${leagueSeasonId}:${week}`, `result:${leagueSeasonId}:${week}`]),
  ...(ownsSeason ? [`calendar:${seasonYear}`, ...[1, 2, 3].map((week) => `nba:${seasonYear}:${week}`)] : []),
]
try {
  ;({ supabase } = await import(source('supabase')))
  const jobs = await import(source('backfillJobs'))
  const { runBBRefChunk } = await import(source('bbrefBackfill'))
  const { fetchBBRefBoxScore } = await import(source('bbref'))
  const { syncScores } = await import(source('syncScores'))
  const { runSeasonBoundary } = await import(source('seasonBoundary'))
  const start = 1800 + crypto.getRandomValues(new Uint32Array(1))[0] % 100
  for (let index = 0; index < 100; index++) {
    const year = 1800 + (start - 1800 + index) % 100
    const available = await sql.sql(`SELECT NOT EXISTS (SELECT 1 FROM public.nba_games WHERE season_year=${year})
      AND NOT EXISTS (SELECT 1 FROM public.season_weeks WHERE season_year=${year})
      AND NOT EXISTS (SELECT 1 FROM public.league_seasons WHERE season_year=${year})
      AND NOT EXISTS (SELECT 1 FROM public.sync_jobs WHERE job_type LIKE 'backfill_%_${year}')
      AND NOT EXISTS (SELECT 1 FROM private.score_input_revisions WHERE scope='calendar:${year}' OR scope LIKE 'nba:${year}:%')`)
    if (available !== 't') continue
    if (await sql.sql(`SELECT pg_try_advisory_lock(hashtext('bbref-partial-fixture'),${year})`) !== 't') continue
    seasonYear = year
    break
  }
  assert.ok(seasonYear, 'An unused fixture season is required')
  gameKey = `${seasonYear - 1}10010BOS`
  assert.equal(await sql.sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${scopes().map(literal).join(',')})`), '0')
  assert.deepEqual(await q(supabase.from('players').select('id').in('id', playerIds)), [])
  assert.equal(await sql.sql(`SELECT (SELECT count(*) FROM public.leagues WHERE id='${leagueId}')
    + (SELECT count(*) FROM public.league_seasons WHERE id='${leagueSeasonId}')
    + (SELECT count(*) FROM public.league_members WHERE id IN (${memberIds.map(literal).join(',')}))`), '0')
  mayCleanRevisions = true
  await q(supabase.from('players').insert(playerIds.map((id, index) => ({
    id, first_name: 'Synthetic', last_name: `${['Starter', 'Home', 'Away'][index]}${suffix}`,
    position: 'PG', eligible_positions: ['PG'], nba_team: index === 2 ? 'NYK' : 'BOS', years_exp: 2,
  }))))
  ownsPlayers = true
  const newJob = async () => { jobId = await jobs.createBackfillJob('bbref', seasonYear); ownJobIds.push(jobId) }
  const run = async (retry: boolean) => {
    const { job, claimToken } = await jobs.claimBackfillJob(jobId, null)
    const admitted = { ...jobs.backfillJobAuthority(job, {}), jobId, claimToken }
    try {
      if (retry) admitted.retryBefore = await jobs.beginBackfillRetry(admitted, job.metadata)
      assert.equal(await runBBRefChunk(admitted, 0), false)
    } finally {
      if (admitted.retryBefore) await jobs.endBackfillRetry(admitted)
      await jobs.releaseBackfillJob(jobId, claimToken)
    }
  }
  const snapshot = async () => {
    const game = await q(supabase.from('nba_games').select('id,status,stats_synced_at').eq('nba_game_id', gameKey).single())
    gameDbId = game.id
    const stats = await q(supabase.from('player_game_stats').select('*').eq('game_id', game.id).order('player_id'))
    const ledger = await q(supabase.from('backfill_game_attempts').select('status,last_error').eq('job_id', jobId).eq('game_key', gameKey).single())
    const job = await q(supabase.from('sync_jobs').select('status,completed_items,failed_items,metadata,claim_token').eq('id', jobId).single())
    return { game, stats, ledger, job }
  }
  const print = (stage: string, value: any) => console.log(JSON.stringify({ stage, case: caseArg, expected: expectArg, ...value }))
  await newJob()
  ownsSeason = true
  await run(false)
  const first = await snapshot()
  ownWeekIds.push(...(await q(supabase.from('season_weeks').select('id').eq('season_year', seasonYear))).map((week: any) => week.id))
  print(`first-${caseArg}-import-before-assertion`, first)
  assert.equal(first.game.status, 'Final')
  assert.equal(first.job.claim_token, null)
  if (repairedFirstComplete) {
    assert.ok(first.game.stats_synced_at)
    assert.equal(first.stats.length, 3)
    assert.deepEqual(new Set(first.stats.map((stat: any) => stat.player_id)), new Set(playerIds))
    assert.equal(first.stats.find((stat: any) => stat.player_id === playerIds[0])[scoreColumn], homeScore)
    assert.equal(first.ledger.status, 'completed')
    assert.equal(first.job.status, 'completed')
    assert.equal(first.job.completed_items, 1)
    assert.equal(first.job.failed_items, 0)
  } else {
    assert.equal(first.game.stats_synced_at, null)
    assert.deepEqual(first.stats, [])
    assert.equal(first.ledger.status, 'failed')
    assert.match(first.ledger.last_error, /BBRef/)
    assert.equal(first.job.status, 'completed_with_errors')
    assert.equal(first.job.completed_items, 0)
    assert.equal(first.job.failed_items, 1)
  }
  print(`first-${caseArg}-import`, first)

  // Direct unnamed control uses the real fetch/parser without any database write.
  mode = 'unnamed'
  {
    await assert.rejects(() => fetchBBRefBoxScore(gameKey, 'BOS', 'NYK'), /BBRef/)
  }
  print('unnamed-active-row', { rejected: true })
  mode = 'unlinked'
  const unlinked = await fetchBBRefBoxScore(gameKey, 'BOS', 'NYK')
  assert.deepEqual([...unlinked.home, ...unlinked.away].map((stat: any) => stat.playerName), names)
  assert.equal(unlinked.home[0].pts, shortAppearance ? 0 : 30)
  print('named-unlinked-header-control', { playerRows: 3, starterRetained: true })
  mode = 'valid'
  const parsed = await fetchBBRefBoxScore(gameKey, 'BOS', 'NYK')
  assert.deepEqual([...parsed.home, ...parsed.away].map((stat: any) => stat.playerName), names)
  assert.equal(parsed.home[0].pts, shortAppearance ? 0 : 30)
  print('header-totals-control', { playerRows: 3, starterPoints: shortAppearance ? 0 : 30 })
  mode = 'dnp'
  const dnp = await fetchBBRefBoxScore(gameKey, 'BOS', 'NYK')
  assert.equal(dnp.home.length, 2)
  assert.equal(dnp.away.length, 1)
  assert.equal(dnp.home[0].playerName, names[0])
  assert.equal(dnp.home[0].dnp, true)
  assert.equal(dnp.home[0].minutesDecimal, null)
  assert.equal(dnp.home[0].pts, 0)
  print('linked-explicit-DNP-control', { playerRows: 3, dnp: true, points: 0 })

  const gameDate = `${seasonYear - 1}-10-01`
  const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
  const extraWeeks = await q(supabase.from('season_weeks').insert([2, 3].map((week) => ({
    season_year: seasonYear, week_number: week,
    week_start: addDays(gameDate, (week - 1) * 7), week_end: addDays(gameDate, (week - 1) * 7 + 6),
  }))).select('id'))
  ownWeekIds.push(...extraWeeks.map((week: any) => week.id))
  for (let index = 0; index < memberIds.length; index++) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `partial-bbref-${suffix}-${index}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
      user_metadata: { username: `partial_${suffix.slice(0, 12)}_${index}`, display_name: 'Synthetic BBRef scoring' },
    })
    if (error) throw new Error(error.message)
    assert.ok(data.user)
    userIds.push(data.user.id)
  }
  await q(supabase.from('leagues').insert({ id: leagueId, slug: `partial-bbref-${suffix}`,
    name: 'Synthetic partial BBRef scoring', commissioner_id: userIds[0], status: 'active',
    scoring_settings: { [scoreColumn]: 1 }, playoff_start_week: 1, playoff_total_weeks: 2, playoff_round_weeks: [1, 1] }))
  ownsLeague = true
  await q(supabase.from('league_members').insert(memberIds.map((id, index) => ({
    id, league_id: leagueId, user_id: userIds[index], role: index ? 'manager' : 'commissioner', team_name: `Fixture ${index}`,
  }))))
  await q(supabase.from('league_seasons').insert({ id: leagueSeasonId, league_id: leagueId, season_year: seasonYear, is_current: true }))
  const readSemis = () => q(supabase.from('matchups').select('*').eq('league_season_id', leagueSeasonId)
    .eq('matchup_type', 'playoff_semifinal').order('id'))
  const generated = await runSeasonBoundary(new Date(), leagueId)
  assert.ok(generated.some((result: any) => result.actions.includes('bracket-generated')))
  const semis = await readSemis()
  assert.equal(semis.length, 2)
  const targetId = semis[0].id
  const assignments = [{ player_id: playerIds[0], member_id: semis[0].home_member_id },
    { player_id: playerIds[2], member_id: semis[0].away_member_id }]
  await q(supabase.from('roster_players').insert(assignments.map((value) => ({ ...value,
    league_id: leagueId, league_season_id: leagueSeasonId, acquired_via: 'draft', acquired_at: `${addDays(gameDate, -7)}T12:00:00Z`,
  }))))
  await q(supabase.from('weekly_lineups').delete().eq('league_id', leagueId))
  await q(supabase.from('weekly_lineups').insert(assignments.map((value) => ({ ...value,
    league_id: leagueId, league_season_id: leagueSeasonId, week_number: 1,
    game_date: gameDate, slot_type: 'PG', is_auto_set: false,
  }))))
  const readTarget = async () => (await readSemis()).find((row: any) => row.id === targetId)
  await syncScores(leagueId)
  const firstScore = await readTarget()
  assert.ok(firstScore)
  if (repairedFirstComplete) {
    assert.equal(firstScore.is_finalized, true)
    assert.equal(Number(firstScore.home_points), homeScore)
    assert.equal(Number(firstScore.away_points), awayScore)
    assert.equal(firstScore.winner_member_id, firstScore.home_member_id)
  } else {
    assert.equal(firstScore.is_finalized, false)
    assert.equal(firstScore.winner_member_id, null)
  }
  print('actual-first-import-score', { stored: firstScore, completeProviderScore: { home: homeScore, away: awayScore }, wrongWinner: false })
  const firstSql = JSON.parse(await sql.sql(`SELECT jsonb_build_object(
    'marker',(SELECT stats_synced_at FROM public.nba_games WHERE id='${gameDbId}'),
    'players',(SELECT jsonb_agg(player_id ORDER BY player_id) FROM public.player_game_stats WHERE game_id='${gameDbId}'),
    'ledger',(SELECT status FROM public.backfill_game_attempts WHERE job_id='${jobId}' AND game_key='${gameKey}'),
    'score',(SELECT jsonb_build_object('home',home_points,'away',away_points,'finalized',is_finalized,'winner',winner_member_id)
      FROM public.matchups WHERE id='${targetId}'))`))
  assert.equal(firstSql.ledger, firstHasMarker ? 'completed' : 'failed')
  assert.equal(firstSql.score.finalized, firstHasMarker)
  if (repairedFirstComplete) {
    assert.equal(firstSql.players.length, 3)
    assert.equal(firstSql.score.winner, firstScore.home_member_id)
    assert.equal(Number(firstSql.score.home), homeScore)
    assert.equal(Number(firstSql.score.away), awayScore)
    assert.ok(firstSql.marker)
  } else {
    assert.equal(firstSql.marker, null)
    assert.equal(firstSql.players, null)
    assert.equal(firstSql.score.winner, null)
  }
  print('direct-postgresql-first-import', firstSql)

  // Completed first imports need a new job. Repaired unnamed failures use their original retry.
  mode = 'valid'
  if (firstHasMarker) await newJob()
  await run(!firstHasMarker)
  const complete = await snapshot()
  assert.equal(complete.stats.length, 3)
  assert.deepEqual(new Set(complete.stats.map((stat: any) => stat.player_id)), new Set(playerIds))
  assert.equal(complete.stats.find((stat: any) => stat.player_id === playerIds[0])[scoreColumn], homeScore)
  assert.ok(complete.game.stats_synced_at)
  assert.equal(complete.ledger.status, 'completed')
  assert.equal(complete.job.status, 'completed')
  assert.equal(complete.job.metadata.retryBefore, undefined)
  assert.equal(complete.job.claim_token, null)
  await syncScores(leagueId)
  const completeScore = await readTarget()
  assert.equal(completeScore.is_finalized, true)
  assert.equal(Number(completeScore.home_points), homeScore)
  assert.equal(Number(completeScore.away_points), awayScore)
  assert.equal(completeScore.winner_member_id, shortAppearance ? completeScore.away_member_id : completeScore.home_member_id)
  print('complete-linked-import', { state: complete, score: completeScore })

  const beforeStats = complete.stats, beforeMarker = complete.game.stats_synced_at
  await newJob()
  mode = shortAppearance ? 'omitted-short-player' : ['excess-turnovers', 'negative-counts'].includes(caseArg) ? caseArg : caseArg === 'missing-minutes' ? 'missing-minutes' : 'unnamed'
  await run(false)
  const refresh = await snapshot()
  assert.deepEqual(refresh.stats, beforeStats, 'Malformed refresh preserves every stored field')
  assert.equal(refresh.game.stats_synced_at, beforeMarker, 'Malformed refresh preserves the exact marker')
  assert.equal(refresh.ledger.status, 'failed')
  assert.equal(refresh.job.status, 'completed_with_errors')
  assert.match(refresh.ledger.last_error, /BBRef/)
  await syncScores(leagueId)
  const preserved = await readTarget()
  assert.equal(Number(preserved.home_points), homeScore)
  assert.equal(Number(preserved.away_points), awayScore)
  assert.equal(preserved.winner_member_id, shortAppearance ? preserved.away_member_id : preserved.home_member_id)
  print('malformed-refresh', { state: refresh, allStoredStatsUnchanged: true, markerUnchanged: true, score: preserved })

  mode = 'valid'
  const scheduleBeforeRetry = scheduleHits
  await run(true)
  assert.equal(scheduleHits, scheduleBeforeRetry, 'Explicit retry reuses the published schedule')
  const retry = await snapshot()
  assert.equal(retry.stats.length, 3)
  assert.equal(retry.ledger.status, 'completed')
  assert.equal(retry.job.status, 'completed')
  assert.equal(retry.job.completed_items, 1)
  assert.equal(retry.job.failed_items, 0)
  assert.equal(retry.job.claim_token, null)
  assert.equal(retry.job.metadata.retryBefore, undefined)
  await syncScores(leagueId)
  const retryScore = await readTarget()
  assert.equal(retryScore.is_finalized, true)
  assert.equal(Number(retryScore.home_points), homeScore)
  assert.equal(Number(retryScore.away_points), awayScore)
  assert.equal(retryScore.winner_member_id, shortAppearance ? retryScore.away_member_id : retryScore.home_member_id)
  print('actual-valid-linked-retry', { state: retry, score: retryScore, scheduleHits, boxHits, realRpcResponses })
  // Independent SQL read proves the marker, ledger, and score exist in PostgreSQL.
  const sqlState = await sql.sql(`SELECT jsonb_build_object(
    'game',(SELECT to_jsonb(g) FROM public.nba_games g WHERE id='${gameDbId}'),
    'stats',(SELECT jsonb_agg(to_jsonb(s) ORDER BY player_id) FROM public.player_game_stats s WHERE game_id='${gameDbId}'),
    'attempt',(SELECT to_jsonb(a) FROM public.backfill_game_attempts a WHERE job_id='${jobId}' AND game_key='${gameKey}'),
    'score',(SELECT to_jsonb(m) FROM public.matchups m WHERE id='${targetId}'))`)
  const direct = JSON.parse(sqlState)
  assert.equal(direct.stats.length, 3)
  assert.equal(direct.attempt.status, 'completed')
  assert.equal(Number(direct.score.home_points), homeScore)
  assert.equal(Number(direct.score.away_points), awayScore)
  assert.ok(direct.game.stats_synced_at)
  print('direct-postgresql-read', direct)
} finally {
  const errors: unknown[] = []
  const clean = async (operation: () => Promise<unknown>) => { try { await operation() } catch (error) { errors.push(error) } }
  if (supabase) {
    if (ownsLeague) await clean(() => q(supabase.from('leagues').delete().eq('id', leagueId)))
    for (const id of ownJobIds) {
      await clean(() => q(supabase.from('backfill_game_attempts').delete().eq('job_id', id)))
      await clean(() => q(supabase.from('sync_jobs').delete().eq('id', id)))
    }
    if (!gameDbId && ownsSeason) await clean(async () => {
      const game = await q(supabase.from('nba_games').select('id').eq('nba_game_id', gameKey).maybeSingle())
      gameDbId = game?.id
    })
    if (gameDbId) {
      await clean(() => q(supabase.from('player_game_stats').delete().eq('game_id', gameDbId!)))
      await clean(() => q(supabase.from('nba_games').delete().eq('id', gameDbId!)))
    }
    if (ownsPlayers) await clean(() => q(supabase.from('players').delete().in('id', playerIds)))
    // IDs are authoritative. On an early publish failure, recover only this unused season's weeks.
    if (ownsSeason && ownWeekIds.length === 0) await clean(async () => {
      ownWeekIds.push(...(await q(supabase.from('season_weeks').select('id').eq('season_year', seasonYear))).map((week: any) => week.id))
    })
    if (ownWeekIds.length) await clean(() => q(supabase.from('season_weeks').delete().in('id', ownWeekIds)))
    for (const id of userIds) await clean(async () => {
      const { error } = await supabase.auth.admin.deleteUser(id)
      if (error) throw new Error(error.message)
    })
    // Cleanup happens after all trigger-producing deletes. No wildcard revision delete.
    if (mayCleanRevisions) {
      await clean(() => sql.sql(`DELETE FROM private.score_input_revisions WHERE scope IN (${scopes().map(literal).join(',')})`))
      await clean(async () => assert.equal(await sql.sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope IN (${scopes().map(literal).join(',')})`), '0'))
      await clean(async () => assert.equal(await sql.sql(`SELECT
        (SELECT count(*) FROM public.players WHERE id IN (${playerIds.map(literal).join(',')}))
        + (SELECT count(*) FROM public.leagues WHERE id='${leagueId}')
        + (SELECT count(*) FROM public.league_seasons WHERE id='${leagueSeasonId}')
        + (SELECT count(*) FROM public.nba_games WHERE nba_game_id='${gameKey}')
        ${ownWeekIds.length ? `+ (SELECT count(*) FROM public.season_weeks WHERE id IN (${ownWeekIds.map(literal).join(',')}))` : ''}
        ${ownJobIds.length ? `+ (SELECT count(*) FROM public.sync_jobs WHERE id IN (${ownJobIds.map(literal).join(',')}))
        + (SELECT count(*) FROM public.backfill_game_attempts WHERE job_id IN (${ownJobIds.map(literal).join(',')}))` : ''}
        ${gameDbId ? `+ (SELECT count(*) FROM public.player_game_stats WHERE game_id='${gameDbId}')` : ''}
        ${userIds.length ? `+ (SELECT count(*) FROM auth.users WHERE id IN (${userIds.map(literal).join(',')}))` : ''}`), '0'))
    }
  }
  await clean(() => sql.close())
  globalThis.fetch = nativeFetch
  await clean(() => provider.shutdown())
  console.log(JSON.stringify({ cleanupErrors: errors.map((error) => error instanceof Error ? error.message : String(error)) }))
  if (errors.length) throw new AggregateError(errors, 'Owned fixture cleanup failed')
}
