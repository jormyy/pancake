import assert from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
const { ingestTick, runLivePoll } = await import('./runner.ts')

const lockTimeout = { code: '55P03', message: 'canceling statement due to lock timeout' }
const holder = '00000000-0000-4000-8000-000000000001'

async function withDatabase(run: (calls: string[]) => Promise<void>, respond: (name: string, count: number) => Response) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const name = url.pathname.split('/').at(-1)!
    calls.push(name)
    assert.ok(['database.invalid', 'nba.invalid'].includes(url.hostname))
    if (name === 'try_live_poll_lease') return Promise.resolve(Response.json(holder))
    if (name === 'release_live_poll_lease') return Promise.resolve(Response.json(null))
    if (name === 'sync_runs') return Promise.resolve(Response.json({ id: holder }))
    return Promise.resolve(respond(name, calls.filter(value => value === name).length))
  }
  try { await run(calls) } finally { globalThis.fetch = original }
}

Deno.test('the live loop recovers a lock timeout without retaining a failed tick', async () => {
  await withDatabase(async calls => {
    const response = await runLivePoll(new Request('http://function.invalid'))
    const result = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(result.failures, [])
    assert.equal(result.tickRetries, 1)
    assert.equal(calls.filter(name => name === 'get_live_poll_work').length, 2)
  }, (name, count) => {
    assert.equal(name, 'get_live_poll_work')
    return count === 1 ? Response.json(lockTimeout, { status: 500 }) : Response.json([])
  })
})

Deno.test('a permanent tick error receives no retry', async () => {
  await withDatabase(async calls => {
    await assert.rejects(() => ingestTick(holder), error => (error as { code: string }).code === '23514')
    assert.equal(calls.length, 1)
  }, () => Response.json({ code: '23514', message: 'invalid game' }, { status: 500 }))
})

Deno.test('persistent tick contention remains a failure after five attempts', async () => {
  let retries = 0
  await withDatabase(async calls => {
    await assert.rejects(() => ingestTick(holder, () => { retries++ }), error => (error as { code: string }).code === '55P03')
    assert.equal(calls.length, 5)
    assert.equal(retries, 4)
  }, () => Response.json(lockTimeout, { status: 500 }))
})

Deno.test('scoreboard writes retry without fetching the provider again', async () => {
  await withDatabase(async calls => {
    const result = await ingestTick(holder)
    assert.deepEqual(result.failures, [])
    assert.equal(result.tickRetries, 1)
    assert.equal(calls.filter(name => name === 'todaysScoreboard_00.json').length, 1)
    assert.equal(calls.filter(name => name === 'save_live_scoreboard_atomic').length, 2)
  }, (name, count) => {
    if (name === 'get_live_poll_work') return Response.json(count === 1 ? [{
      id: holder, nba_game_id: '0022600001', status: 'InProgress', needs_scoreboard: true, needs_stats: false,
      home_score: 0, away_score: 0, game_status_text: 'Q1',
    }] : [])
    if (name === 'record_live_poll_attempts') return Response.json(null)
    if (name === 'todaysScoreboard_00.json') return Response.json({ scoreboard: { games: [{
      gameId: '0022600001', gameStatus: 2, gameStatusText: 'Q1', period: 1, gameClock: 'PT06M00.00S',
      homeTeam: { score: 10 }, awayTeam: { score: 8 },
    }] } })
    assert.equal(name, 'save_live_scoreboard_atomic')
    return count === 1 ? Response.json(lockTimeout, { status: 500 }) : Response.json(true)
  })
})

Deno.test('a final stat write retries its captured game after the attempt stamp', async () => {
  await withDatabase(async calls => {
    const result = await ingestTick(holder)
    assert.deepEqual(result.failures, [])
    assert.equal(result.lines, 2)
    assert.equal(result.tickRetries, 1)
    assert.equal(result.keepRunning, false)
    assert.equal(calls.filter(name => name === 'record_live_poll_attempts').length, 1)
    assert.equal(calls.filter(name => name === 'get_live_poll_work').length, 1)
    assert.equal(calls.filter(name => name === 'save_game_stats_atomic').length, 2)
  }, (name, count) => {
    if (name === 'get_live_poll_work') return Response.json([{
      id: holder, nba_game_id: '0022600001', status: 'Final', needs_scoreboard: false, needs_stats: true,
      season_year: 2027, week_number: 1,
    }])
    if (name === 'record_live_poll_attempts' || name === 'assert_nba_game_unambiguous') return Response.json(null)
    if (name === 'league_seasons') return Response.json([])
    if (name === 'boxscore_0022600001.json') {
      const statistics = Object.fromEntries([
        'assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal',
        'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points',
        'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal', 'steals',
        'threePointersAttempted', 'threePointersMade', 'turnovers',
      ].map(key => [key, 0]))
      const team = (personId: number) => ({ players: [{ personId, name: 'Player ' + personId,
        statistics: { ...statistics, points: 10, minutes: 'PT06M00.00S' } }] })
      return Response.json({ game: { gameStatus: 3, homeTeam: team(1), awayTeam: team(2) } })
    }
    if (name === 'resolve_player_imports_atomic') return Response.json({ stale_draft_numbers_cleared: 0,
      results: [1, 2].map((id, index) => ({ index, player_id: 'player-' + id, action: 'updated' })) })
    assert.equal(name, 'save_game_stats_atomic')
    return count === 1 ? Response.json(lockTimeout, { status: 500 }) : Response.json(2)
  })
})
