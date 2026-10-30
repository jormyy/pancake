import assert from 'node:assert/strict'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
Deno.env.set('NBA_CDN_BASE_URL', 'http://nba.invalid')
Deno.env.set('ESPN_LIVE_BASE_URL', 'http://espn.invalid')
const { prepareLiveSources, liveFailureText } = await import('./fallback.ts')
const { EspnLiveSource } = await import('./espn.ts')
const load = async (file: string) => JSON.parse(await Deno.readTextFile(`tests/fixtures/live-espn/${file}`)).payload
const summary = await load('2026-10-30T01-00-49.554Z-summary-401909893.json')
const scoreboard = await load('2026-10-30T01-00-49.445Z-scoreboard.json')
const nba = await load('2026-10-30T01-00-50.022Z-nba-boxscore-0022600144.json')
const now = Date.parse('2026-10-30T01:00:50Z')
const game = { id: '00000000-0000-4000-8000-000000000001', nba_game_id: '0022600144', game_date: '2026-10-29', season_year: 2027, week_number: 2, home_team: 'ATL', away_team: 'CLE', status: 'InProgress' }
const ids = summary.boxscore.players.flatMap((team: { statistics: { athletes: { athlete: { id: string }; didNotPlay: boolean }[] }[] }) => team.statistics[0].athletes.filter(row => !row.didNotPlay).map(row => row.athlete.id))

type Options = { nbaAge?: number; nbaError?: boolean; missing?: boolean; final?: boolean; summaryError?: boolean; identityError?: boolean; espnPost?: boolean; scheduled?: boolean; duplicateNba?: boolean; witness?: boolean }
async function scenario(options: Options, run: (source: Awaited<ReturnType<typeof prepareLiveSources>>, calls: string[]) => Promise<void>) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push(url.pathname)
    assert.ok(['database.invalid', 'nba.invalid', 'espn.invalid'].includes(url.hostname))
    if (url.hostname === 'nba.invalid') {
      if (options.nbaError) return Response.json({}, { status: 403 })
      const payload = structuredClone(nba)
      payload.meta.time = new Date(now - (options.nbaAge ?? 60_000)).toISOString()
      payload.game.period = 2
      payload.game.gameClock = 'PT02M31S'
      payload.game.homeTeam.score = 39
      payload.game.awayTeam.score = 37
      if (options.final) payload.game.gameStatus = 3
      if (options.scheduled) payload.game.gameStatus = 1
      return Response.json(payload)
    }
    if (url.hostname === 'espn.invalid') {
      const payload = options.summaryError ? {} : structuredClone(summary)
      if (options.espnPost) {
        payload.header.competitions[0].status.type.state = 'post'
        payload.header.competitions[0].status.period = 4
        payload.header.competitions[0].status.displayClock = '0.0'
      }
      return Response.json(payload)
    }
    assert.equal(url.pathname, '/rest/v1/players')
    if (options.identityError) return Response.json({ code: '55P03', message: 'canceling statement due to lock timeout' }, { status: 500 })
    return Response.json(ids.slice(options.missing ? 1 : 0).map((id: string, index: number) => ({ id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, espn_id: id, nba_id: options.duplicateNba ? '100' : options.witness && index === 0 ? String(nba.game.homeTeam.players.find((player: { played: string }) => player.played === '1').personId) : String(100 + index) })))
  }
  try {
    const source = await prepareLiveSources([game], scoreboard.events, [], now, new EspnLiveSource(() => now))
    await run(source, calls)
  } finally { globalThis.fetch = original }
}

Deno.test('ESPN is primary even when NBA is less than 90 seconds old at the same clock', async () => {
  await scenario({}, async (source, calls) => {
    const box = await source.loadBoxScore(game)
    assert.equal(box.liveSource, 'espn')
    assert.equal(box.gameId, game.nba_game_id)
    assert.equal(box.livePlayerIds?.length, ids.length)
    assert.equal(box.gameStatus, 2)
    assert.equal(calls.filter(path => path === '/rest/v1/players').length, 1)
    assert.equal(source.observations[0].reason, 'espn-primary')
    assert.equal(source.failures.length, 0)
  })
})

Deno.test('a fresher NBA copy wins and does not need an identity read', async () => {
  await scenario({ nbaAge: 0 }, async (source, calls) => {
    assert.equal((await source.loadBoxScore(game)).liveSource, 'nba')
    assert.equal(source.observations[0].reason, 'nba-newer')
    assert.equal(calls.filter(path => path === '/rest/v1/players').length, 0)
    assert.equal(calls.filter(path => path === '/summary').length, 1)
  })
})

Deno.test('stored final games request only NBA and never ESPN summaries', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input)
    assert.equal(url.hostname, 'nba.invalid')
    calls++
    return Response.json({ ...nba, game: { ...nba.game, gameStatus: 3 } })
  }
  try {
    const source = await prepareLiveSources([{ ...game, status: 'Final' }], scoreboard.events, [], now)
    assert.equal((await source.loadBoxScore(game)).gameStatus, 3)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

Deno.test('an NBA HTTP error leaves the primary ESPN live box available', async () => {
  await scenario({ nbaError: true }, async source => { assert.equal((await source.loadBoxScore(game)).liveSource, 'espn') })
})

Deno.test('an inconsistent ESPN snapshot falls back to NBA without failing healthy scoring', async () => {
  await scenario({ summaryError: true }, async source => {
    assert.equal((await source.loadBoxScore(game)).liveSource, 'nba')
    assert.equal(source.failures.length, 0)
    assert.equal(source.observations[0].reason, 'espn-error')
    assert.ok(source.observations[0].espnError)
  })
})

Deno.test('identity failures use NBA without guessing athlete names', async () => {
  for (const options of [{ missing: true }, { identityError: true }, { duplicateNba: true }]) {
    await scenario(options, async source => {
      assert.equal((await source.loadBoxScore(game)).liveSource, 'nba')
      assert.equal(source.observations[0].reason, 'espn-identity-error')
      assert.equal(source.failures.length, 0)
    })
  }
})

Deno.test('both source failures retain the game and input details', async () => {
  await scenario({ missing: true, nbaError: true }, async source => {
    await assert.rejects(() => source.loadBoxScore(game), error => /identity link/.test(liveFailureText(error)) && /0022600144/.test(liveFailureText(error)))
  })
})

Deno.test('ESPN post-game values remain live until NBA certification', async () => {
  await scenario({ espnPost: true }, async source => {
    const box = await source.loadBoxScore(game)
    assert.equal(box.liveSource, 'espn')
    assert.equal(box.gameStatus, 2)
    assert.equal(box.gameStatusText, 'Awaiting final stats')
  })
})

Deno.test('a stale scheduled NBA copy cannot suppress a live ESPN game', async () => {
  await scenario({ scheduled: true, nbaAge: 0 }, async source => { assert.equal((await source.loadBoxScore(game)).liveSource, 'espn') })
})

Deno.test('partial score failures retain nested input details and SQL codes', () => {
  const failure = Object.assign(new Error('Game inputs changed'), { code: 'PT409' })
  const text = liveFailureText(new AggregateError([new AggregateError([failure], 'league fixture/week 2')], 'Score sync failed'))
  assert.match(text, /league fixture\/week 2: PT409: Game inputs changed/)
})

Deno.test('NBA participants remain witnessed while ESPN supplies the live values', async () => {
  await scenario({ witness: true }, async source => {
    const box = await source.loadBoxScore(game)
    assert.equal(box.liveSource, 'espn')
    assert.deepEqual(box.nbaWitnessPlayerIds, ['00000000-0000-4000-8001-000000000000'])
  })
})
