import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
assert.ok(api, 'Local backend configuration is required')
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname), 'Only a local backend is allowed')
const playerIds = [crypto.randomUUID(), crypto.randomUUID()]
const suffix = crypto.randomUUID().replaceAll('-', '')
const homeName = `Synthetic Home${suffix}`
const awayName = `Synthetic Away${suffix}`
let seasonYear = 0, gameKey = '', gameDbId: string | null = null
let jobId: string | null = null
const ownJobIds: string[] = []
const leagueId = crypto.randomUUID(), leagueSeasonId = crypto.randomUUID()
const memberIds = Array.from({ length: 4 }, () => crypto.randomUUID())
const userIds: string[] = []
let ownsLeague = false
let ownsSeason = false
let mode: 'http-failure' | 'malformed' | 'unknown-name' | 'valid' = 'http-failure'
let scheduleHits = 0, boxHits = 0
const writeOrder: string[] = []
const columns = {
  mp: '20:00', pts: '12', trb: '4', orb: '1', drb: '3', ast: '2', stl: '1',
  blk: '0', tov: '1', pf: '2', fg: '5', fga: '9', fg3: '1', fg3a: '3',
  ft: '1', fta: '2', plus_minus: '+3',
}
const table = (team: string, name: string, malformed = false) => {
  const values = { ...columns, ...(malformed ? { pts: 'bad' } : {}) }
  return `<table id="box-${team}-game-basic"><tbody><tr>` +
    `<th data-stat="player"><a href="/players/local.html">${name}</a></th>` +
    Object.entries(values).map(([key, value]) =>
      `<td data-stat="${key}">${value}</td>`).join('') +
    '</tr></tbody><tfoot><tr><th data-stat="player">Team Totals</th>' +
    Object.entries(columns).map(([key, value]) => `<td data-stat="${key}">${key === 'mp' ? '20' : value}</td>`).join('') +
    '</tr></tfoot></table>'
}
const provider = Deno.serve(
  { hostname: '127.0.0.1', port: 0, onListen() {} },
  (request) => {
    const path = new URL(request.url).pathname
    if (path === `/leagues/NBA_${seasonYear}_games.html`) {
    return new Response(`<a href="/leagues/NBA_${seasonYear}_games-october.html">October</a>`)
  }
  if (path === `/leagues/NBA_${seasonYear}_games-october.html`) {
      scheduleHits++
      return new Response(`<table id="schedule"><tbody>` +
        `<tr><td data-stat="box_score_text"><a href="/boxscores/${gameKey}.html">Box Score</a></td>` +
        `<td data-stat="visitor_team_name"><a href="/teams/NYK/${seasonYear}.html">New York</a></td></tr>` +
        '<tr class="thead"><th>Playoffs</th></tr></tbody></table>',
        { headers: { 'Content-Type': 'text/html' } })
    }
    if (path === `/boxscores/${gameKey}.html`) {
      boxHits++
      if (mode === 'http-failure') return new Response('local failure', { status: 503 })
      const away = mode === 'unknown-name' ? `Unknown Missing${suffix}` : awayName
      return new Response(table('BOS', homeName, mode === 'malformed') + table('NYK', away),
        { headers: { 'Content-Type': 'text/html' } })
    }
    throw new Error('Unexpected local BBRef path')
  },
)
const origin = `http://127.0.0.1:${provider.addr.port}`
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin === 'https://www.basketball-reference.com') {
    assert.ok([
      `/leagues/NBA_${seasonYear}_games.html`, `/leagues/NBA_${seasonYear}_games-october.html`, `/boxscores/${gameKey}.html`,
    ].includes(url.pathname), 'Only fixture BBRef paths are permitted')
    return nativeFetch(`${origin}${url.pathname}${url.search}`, init)
  }
  assert.ok([new URL(api).origin, origin].includes(url.origin), 'External origin is forbidden')
  const response = await nativeFetch(input, init)
  if (response.ok && init && 'body' in init && typeof init.body === 'string') {
    const body = JSON.parse(init.body)
    const method = 'method' in init ? init.method : undefined
    if (url.pathname === '/rest/v1/rpc/save_game_stats_atomic' && method === 'POST' && body.p_is_final) writeOrder.push('atomic-stats-and-marker')
    if (url.pathname === '/rest/v1/player_game_stats' && method === 'POST') writeOrder.push('stats')
    if (url.pathname === '/rest/v1/nba_games' && method === 'PATCH' && body.stats_synced_at) writeOrder.push('marker')
    if (url.pathname === '/rest/v1/backfill_game_attempts' && body.status === 'completed') writeOrder.push('completed-ledger')
  }
  return response
}

try {
  const { supabase } = await import('../../functions/_shared/supabase.ts')
  const jobs = await import('../../functions/_shared/backfillJobs.ts')
  const { runBBRefChunk } = await import('../../functions/_shared/bbrefBackfill.ts')
  const { syncScores } = await import('../../functions/_shared/syncScores.ts')
  const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
  const q = async (operation: any): Promise<any> => {
    const { data, error } = await operation
    if (error) throw new Error(error.message)
    return data
  }
  try {
    const start = 1800 + crypto.getRandomValues(new Uint32Array(1))[0] % 100
    for (let i = 0; i < 100; i++) {
      const candidate = 1800 + (start - 1800 + i) % 100
      const games = await q(supabase.from('nba_games').select('id').eq('season_year', candidate))
      const weeks = await q(supabase.from('season_weeks').select('id').eq('season_year', candidate))
      const existingJobs = await q(supabase.from('sync_jobs').select('id').eq('job_type', `backfill_bbref_${candidate}`))
      const seasons = await q(supabase.from('league_seasons').select('id').eq('season_year', candidate))
      if (!games.length && !weeks.length && !existingJobs.length && !seasons.length) {
        seasonYear = candidate
        break
      }
    }
    assert.ok(seasonYear, 'An unused synthetic season is required')
    gameKey = `${seasonYear - 1}10010BOS`
    await q(supabase.from('players').insert(playerIds.map((id, index) => ({
      id, first_name: 'Synthetic', last_name: `${index ? 'Away' : 'Home'}${suffix}`,
      position: 'PG' as const, eligible_positions: ['PG'], nba_team: 'BOS', years_exp: 2,
    }))))
    jobId = await jobs.createBackfillJob('bbref', seasonYear)
    ownJobIds.push(jobId)
    ownsSeason = true
    const run = async (retry: boolean) => {
      const { job, claimToken } = await jobs.claimBackfillJob(jobId!, null)
      const authority = jobs.backfillJobAuthority(job, {})
      const admitted = { ...authority, jobId: jobId!, claimToken }
      try {
        await assert.rejects(() => jobs.claimBackfillJob(jobId!, null), /already running/)
        if (retry) admitted.retryBefore = await jobs.beginBackfillRetry(admitted, job.metadata)
        assert.equal(await runBBRefChunk(admitted, 0), false)
        if (admitted.retryBefore) await jobs.endBackfillRetry(admitted)
      } finally {
        await jobs.releaseBackfillJob(jobId!, claimToken)
      }
    }
    const snapshot = async () => {
      const game = await q(supabase.from('nba_games').select('id,status,stats_synced_at').eq('nba_game_id', gameKey).single())
      gameDbId = game.id
      const stats = await q(supabase.from('player_game_stats').select('player_id,points,minutes_played').eq('game_id', game.id))
      const ledger = await q(supabase.from('backfill_game_attempts').select('status,last_error').eq('job_id', jobId!).eq('game_key', gameKey).single())
      const job = await q(supabase.from('sync_jobs').select('status,completed_items,failed_items,metadata,claim_token').eq('id', jobId!).single())
      return { game, stats, ledger, job }
    }
    const failed = async (label: string, pattern: RegExp) => {
      const value = await snapshot()
      assert.equal(value.game.status, 'Final')
      assert.equal(value.game.stats_synced_at, null)
      assert.equal(value.stats.length, 0)
      assert.equal(value.ledger.status, 'failed')
      assert.match(value.ledger.last_error, pattern)
      assert.equal(value.job.status, 'completed_with_errors')
      assert.equal(value.job.failed_items, 1)
      assert.equal(value.job.completed_items, 0)
      assert.equal(value.job.claim_token, null)
      assert.equal(value.job.metadata.retryBefore, undefined)
      console.log(JSON.stringify({ control: label, marker: null, stats: 0, ledger: 'failed' }))
    }
    await run(false)
    await failed('provider-failure', /503/)
    assert.equal(scheduleHits, 1)
    const gameDate = `${seasonYear - 1}-10-01`
    const addDays = (date: string, days: number) =>
      new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
    // Extra past weeks let the real scorer select a current-or-previous week.
    await q(supabase.from('season_weeks').insert([2, 3].map((week) => ({
      season_year: seasonYear, week_number: week,
      week_start: addDays(gameDate, (week - 1) * 7),
      week_end: addDays(gameDate, (week - 1) * 7 + 6),
    }))))
    for (let index = 0; index < memberIds.length; index++) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `bbref-${suffix}-${index}@example.test`,
        password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
        user_metadata: {
          username: `bbref_${suffix.slice(0, 14)}_${index}`,
          display_name: 'Synthetic BBRef scoring',
        },
      })
      if (error) throw new Error(error.message)
      assert.ok(data.user)
      userIds.push(data.user.id)
    }
    await q(supabase.from('leagues').insert({
      id: leagueId, slug: `bbref-${suffix}`, name: 'Synthetic BBRef scoring',
      commissioner_id: userIds[0], status: 'active', scoring_settings: { points: 1 },
      playoff_start_week: 1, playoff_total_weeks: 2, playoff_round_weeks: [1, 1],
    }))
    ownsLeague = true
    await q(supabase.from('league_members').insert(memberIds.map((id, index) => ({
      id, league_id: leagueId, user_id: userIds[index],
      role: index ? 'manager' as const : 'commissioner' as const,
      team_name: `BBRef side ${index}`,
    }))))
    await q(supabase.from('league_seasons').insert({
      id: leagueSeasonId, league_id: leagueId, season_year: seasonYear, is_current: true,
    }))
    const readSemis = () => q(supabase.from('matchups').select('*')
      .eq('league_season_id', leagueSeasonId).eq('matchup_type', 'playoff_semifinal').order('id'))
    const readFinals = () => q(supabase.from('matchups').select('*')
      .eq('league_season_id', leagueSeasonId).eq('matchup_type', 'playoff_final').order('id'))
    const generated = await runSeasonBoundary(new Date(), leagueId)
    assert.ok(generated.some((result) => result.actions.includes('bracket-generated')),
      'The real boundary must generate a start-week-one bracket')
    const semis = await readSemis()
    assert.equal(semis.length, 2)
    assert.ok(semis.every((row: any) => row.week_number === 1 && row.end_week_number === 1))
    await q(supabase.from('roster_players').insert(semis.map((row: any, index: number) => ({
      player_id: playerIds[index], member_id: row.away_member_id,
      league_id: leagueId, league_season_id: leagueSeasonId, acquired_via: 'draft',
      acquired_at: `${addDays(gameDate, -7)}T12:00:00Z`,
    }))))
    await q(supabase.from('weekly_lineups').delete().eq('league_id', leagueId))
    await q(supabase.from('weekly_lineups').insert(semis.map((row: any, index: number) => ({
      player_id: playerIds[index], member_id: row.away_member_id,
      league_id: leagueId, league_season_id: leagueSeasonId, week_number: 1,
      game_date: gameDate, slot_type: 'PG' as const, is_auto_set: false,
    }))))
    const scoreMissing = async (label: string) => {
      await syncScores(leagueId)
      const rows = await readSemis()
      assert.ok(rows.every((row: any) => !row.is_finalized && row.winner_member_id === null),
        'Failed first BBRef import must not finalize either semifinal')
      assert.equal((await readFinals()).length, 0)
      console.log(JSON.stringify({ control: label, finalized: false, winnerSelected: false }))
    }
    await scoreMissing('provider-failure-real-score')
    mode = 'malformed'
    await run(true)
    await failed('malformed-points', /Malformed BBRef stat pts/)
    await scoreMissing('malformed-points-real-score')
    mode = 'unknown-name'
    await run(true)
    await failed('unknown-away-name', /No canonical player match/)
    await scoreMissing('unknown-away-name-real-score')
    mode = 'valid'
    await run(true)
    const value = await snapshot()
    assert.equal(scheduleHits, 1, 'Retries must reuse the existing schedule')
    assert.equal(boxHits, 4)
    assert.equal(value.stats.length, 2)
    assert.deepEqual(new Set(value.stats.map((row: any) => row.player_id)), new Set(playerIds))
    assert.ok(value.stats.every((row: any) => row.points === 12 && row.minutes_played === 20))
    assert.equal(value.ledger.status, 'completed')
    assert.equal(value.job.status, 'completed')
    assert.equal(value.job.completed_items, 1)
    assert.equal(value.job.failed_items, 0)
    assert.equal(value.job.metadata.retryBefore, undefined)
    assert.equal(value.job.claim_token, null)
    console.log(JSON.stringify({ control: 'retry-complete', stats: 2, markerPresent: value.game.stats_synced_at !== null, writeOrder }))
    assert.ok(value.game.stats_synced_at, 'Successful BBRef import must stamp completion')
    assert.deepEqual(writeOrder, ['atomic-stats-and-marker', 'completed-ledger'], 'Complete stats and marker must commit together before the ledger')
    await syncScores(leagueId)
    const scored = await readSemis()
    assert.equal(scored.length, 2)
    assert.ok(scored.every((row: any) => row.is_finalized &&
      row.winner_member_id === row.away_member_id &&
      Number(row.home_points) === 0 && Number(row.away_points) === 12),
      'Real imported points must finalize each away side at 12 versus zero')
    console.log(JSON.stringify({ control: 'retry-complete-real-score',
      results: scored.map((row: any) => ({ finalized: row.is_finalized,
        home: row.home_points, away: row.away_points,
        awayWins: row.winner_member_id === row.away_member_id })) }))
    assert.equal((await readFinals()).length, 0, 'Scoring must not advance the bracket')
    const latestFinalized = Math.max(...scored.map((row: any) => Date.parse(row.finalized_at)))
    assert.ok(Number.isFinite(latestFinalized))
    const earlyBoundary = await runSeasonBoundary(new Date(`${seasonYear - 1}-10-02T13:00:00Z`), leagueId)
    assert.ok(earlyBoundary.every((result) => !result.error))
    assert.equal((await readFinals()).length, 0, 'The first date after the last game stays inside the correction window')

    const beforeStats = await q(supabase.from('player_game_stats').select('*')
      .eq('game_id', gameDbId!).order('player_id'))
    const beforeMarker = value.game.stats_synced_at
    const primaryJobId = jobId
    jobId = await jobs.createBackfillJob('bbref', seasonYear)
    ownJobIds.push(jobId)
    mode = 'http-failure'
    await run(false)
    const refresh = await snapshot()
    const afterStats = await q(supabase.from('player_game_stats').select('*')
      .eq('game_id', gameDbId!).order('player_id'))
    assert.deepEqual(afterStats, beforeStats, 'Failed refresh must preserve every stored stats field')
    assert.equal(refresh.game.stats_synced_at, beforeMarker, 'Failed refresh must preserve the exact completion marker')
    assert.equal(refresh.ledger.status, 'failed')
    assert.match(refresh.ledger.last_error, /503/)
    assert.equal(refresh.job.status, 'completed_with_errors')
    assert.equal(refresh.job.claim_token, null)
    assert.equal(scheduleHits, 2)
    assert.equal(boxHits, 5)
    assert.deepEqual(writeOrder, ['atomic-stats-and-marker', 'completed-ledger'])
    jobId = primaryJobId
    await syncScores(leagueId)
    const preserved = await readSemis()
    assert.ok(preserved.every((row: any) => row.is_finalized &&
      row.winner_member_id === row.away_member_id &&
      Number(row.home_points) === 0 && Number(row.away_points) === 12))
    console.log(JSON.stringify({ control: 'failed-refresh-preserves-complete-score',
      statsUnchanged: true, markerUnchanged: true, awayWins: true }))

    const afterWindow = await runSeasonBoundary(new Date(), leagueId)
    assert.ok(afterWindow.every((result) => !result.error))
    const finals = await readFinals()
    assert.equal(finals.length, 1, 'The closed game date correction window allows advancement after recent scoring')
    assert.deepEqual(new Set([finals[0].home_member_id, finals[0].away_member_id]),
      new Set(scored.map((row: any) => row.away_member_id)))
    console.log(JSON.stringify({ control: 'real-boundary-after-correction-window', finals: 1, correctWinners: true, fixtureLimit: 'Synthetic historical HTML and accounts; explicit game date references, no real provider access or elapsed wait' }))
  } finally {
    const errors: string[] = []
    const clean = async (label: string, operation: () => Promise<unknown>) => {
      try { await operation() } catch { errors.push(label) }
    }
    if (ownsLeague) await clean('league', () => q(supabase.from('leagues').delete().eq('id', leagueId)))
    for (const ownedJobId of ownJobIds) {
      await clean('attempts', () => q(supabase.from('backfill_game_attempts').delete().eq('job_id', ownedJobId)))
      await clean('job', () => q(supabase.from('sync_jobs').delete().eq('id', ownedJobId)))
    }
    if (!gameDbId && ownsSeason) {
      await clean('game lookup', async () => {
        const found = await q(supabase.from('nba_games').select('id').eq('nba_game_id', gameKey).maybeSingle())
        gameDbId = found?.id ?? null
      })
    }
    if (gameDbId) await clean('stats', () => q(supabase.from('player_game_stats').delete().eq('game_id', gameDbId!)))
    if (gameDbId) await clean('game', () => q(supabase.from('nba_games').delete().eq('id', gameDbId!)))
    if (ownsSeason) await clean('weeks', () => q(supabase.from('season_weeks').delete().eq('season_year', seasonYear)))
    await clean('players', () => q(supabase.from('players').delete().in('id', playerIds)))
    for (const userId of userIds) await clean('user', async () => {
      const { error } = await supabase.auth.admin.deleteUser(userId)
      if (error) throw new Error('Fixture user cleanup failed')
    })
    console.log(JSON.stringify({ cleanupErrors: errors }))
    assert.equal(errors.length, 0, 'Fixture cleanup must succeed')
  }
} finally {
  globalThis.fetch = nativeFetch
  await provider.shutdown()
}
