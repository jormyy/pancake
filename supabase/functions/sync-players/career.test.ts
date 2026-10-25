import { strict as assert } from 'node:assert'

for (const [key, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid', PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  ESPN_CAREER_BASE_URL: 'http://career.invalid', ESPN_SEARCH_BASE_URL: 'http://search.invalid', NBA_COM_BASE_URL: 'http://nba.invalid',
})) Deno.env.set(key, value)

const fixture = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}.json`, import.meta.url)))
const beringer = await fixture('espn-career-beringer')
const search = await fixture('espn-search-beringer')
const nba = await fixture('nba-profile-beringer')
const { syncCareerGames } = await import('./career.ts')
const now = new Date('2026-10-25T16:00:00Z')
const player = (id: string, fields: Record<string, unknown> = {}) => ({
  id, espn_id: id, display_name: `Fixture ${id}`, nba_id: null, nba_team: 'BOS', years_exp: 10,
  career_regular_season_games: null, career_games_base: null, career_games_base_attempted_at: null, ...fields,
})
const veteran = {
  filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
  categories: [{ names: ['gamesPlayed'], totals: ['60'], statistics: [
    { season: { year: 2020 }, stats: ['20'] }, { season: { year: 2027 }, stats: ['40'] },
  ] }],
}

async function run(players: ReturnType<typeof player>[], payloads: Record<string, unknown>, options: {
  rostered?: string[]; lookup?: unknown; profile?: unknown; at?: Date; refuseSave?: boolean; maxPlayers?: number; budgetMs?: number; stall?: boolean; lookupTimeoutMs?: number; statsStatus?: number
} = {}) {
  const originalFetch = globalThis.fetch
  const writes: { path: string; body: Record<string, unknown> }[] = []
  const requests: URL[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(url)
    if (url.hostname === 'nba.invalid') return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(options.profile ?? nba)}</script>`)
    if (url.hostname === 'search.invalid') return Response.json(options.lookup ?? search)
    if (url.hostname === 'career.invalid') {
      if (options.statsStatus) return new Response('unavailable', { status: options.statsStatus })
      if (options.stall) return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      const stats = url.pathname.endsWith('/stats')
      if (stats) assert.equal(url.searchParams.get('seasontype'), '2')
      const id = `${stats ? '' : 'profile:'}${url.pathname.split('/')[2]}`
      return Object.hasOwn(payloads, id) ? Response.json(payloads[id]) : new Response('missing', { status: 404 })
    }
    assert.equal(url.hostname, 'database.invalid', url.href)
    if (url.pathname === '/rest/v1/roster_players') {
      assert.equal(url.searchParams.get('league_seasons.is_current'), 'eq.true')
      return Response.json((options.rostered ?? []).map((player_id, index) => ({ id: String(index), player_id })))
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const body = await request.json()
      writes.push({ path: url.pathname, body })
      const row = players.find(row => row.id === body.p_player_id)!
      assert.ok(row)
      if (url.pathname.endsWith('claim_player_career_base_atomic')) {
        row.career_games_base_attempted_at = body.p_now
        return Response.json(true)
      }
      assert.equal(url.pathname, '/rest/v1/rpc/complete_player_career_base_atomic')
      assert.equal(body.p_espn_id, row.espn_id ?? '')
      assert.equal(body.p_nba_id, row.nba_id ?? '')
      if (options.refuseSave) return Response.json(false)
      if (body.p_base == null && ((row.career_regular_season_games ?? 0) > 0 || row.years_exp !== 0)) return Response.json(false)
      row.career_games_base = body.p_base ?? 0
      return Response.json(true)
    }
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'PATCH') {
      const body = await request.json()
      writes.push({ path: url.pathname, body })
      const row = players.find(row => row.id === url.searchParams.get('id')?.slice(3))!
      Object.assign(row, body)
      return Response.json([{ id: row.id, ...body }])
    }
    return Response.json(players)
  }
  try {
    const result = await syncCareerGames(options.at ?? now, options)
    return { ...result, writes, requests }
  } finally {
    globalThis.fetch = originalFetch
  }
}

Deno.test('every player with a base skips all further career lookups', async () => {
  const result = await run([
    player('known', { career_games_base: 20 }), player('rookie', { years_exp: 0, career_games_base: 0 }),
    player('threshold', { career_games_base: 0, career_regular_season_games: 65 }),
  ], {})
  assert.equal(result.updated, 0)
  assert.equal(result.requests.filter(url => url.hostname !== 'database.invalid').length, 0)
  assert.deepEqual(result.writes, [])
})

Deno.test('a one-time fetch stores completed seasons and never refetches the base', async () => {
  const rows = [player('veteran', { career_regular_season_games: 60 })]
  const first = await run(rows, { veteran })
  assert.equal(first.updated, 1)
  assert.equal(first.unverified, 0)
  assert.equal(rows[0].career_games_base, 20)
  assert.deepEqual(first.writes[1].body, { p_player_id: 'veteran', p_base: 20, p_base_season: 2026,
    p_espn_id: 'veteran', p_nba_id: '', p_season_year: 2027 })
  const repeated = await run(rows, { veteran }, { at: new Date('2027-11-01T16:00:00Z') })
  assert.equal(repeated.requests.filter(url => url.hostname === 'career.invalid').length, 0)
})

Deno.test('a failed lookup retries only after a week and preserves a known total', async () => {
  const rows = [player('missing', { career_regular_season_games: 331 })]
  const first = await run(rows, {})
  assert.equal(first.unverified, 1)
  assert.equal(rows[0].career_games_base, null)
  assert.equal(rows[0].career_regular_season_games, 331)
  const early = await run(rows, {}, { at: new Date('2026-11-01T15:59:59Z') })
  assert.equal(early.requests.filter(url => url.hostname === 'career.invalid').length, 0)
  const due = await run(rows, {}, { at: new Date('2026-11-01T16:00:00Z') })
  assert.equal(due.requests.filter(url => url.hostname === 'career.invalid').length, 1)
})

Deno.test('missing ESPN identity and experience resolve using the existing trusted feeds', async () => {
  const rows = [player('beringer', { display_name: 'Joan Beringer', espn_id: null, nba_id: '1642866', years_exp: null })]
  const result = await run(rows, { '5279133': beringer })
  assert.equal(result.updated, 1)
  assert.deepEqual(result.failures, [])
  assert.equal(rows[0].career_games_base, 40)
  assert.equal(rows[0].years_exp, 1)
  assert.equal(result.requests.filter(url => url.hostname === 'search.invalid').length, 1)
})

Deno.test('bounded work prioritizes current roster players and later processes free agents', async () => {
  const rows = [player('absent', { nba_team: null }), player('current', { nba_team: null })]
  const first = await run(rows, { current: veteran, absent: veteran }, { rostered: ['current'], maxPlayers: 1 })
  assert.equal(first.updated, 1)
  assert.deepEqual(first.requests.filter(url => url.hostname === 'career.invalid').map(url => url.pathname), ['/athletes/current/stats'])
  const second = await run(rows, { absent: veteran }, { maxPlayers: 1 })
  assert.equal(second.updated, 1)
  assert.ok(second.requests.some(url => url.pathname === '/athletes/absent/stats'))
})

Deno.test('a per-run limit and expired budget leave unstarted players unclaimed', async () => {
  const rows = Array.from({ length: 4 }, (_, i) => player(`limited-${i}`))
  const payloads = Object.fromEntries(rows.map(row => [row.id, veteran]))
  const bounded = await run(rows, payloads, { maxPlayers: 2 })
  assert.equal(bounded.updated, 2)
  assert.equal(bounded.writes.filter(row => row.path.endsWith('claim_player_career_base_atomic')).length, 2)
  const expired = await run(rows, payloads, { budgetMs: 0 })
  assert.equal(expired.writes.length, 0)
})

Deno.test('ambiguous and non-NBA searches cannot assign a provider ID', async () => {
  for (const lookup of [{ items: [...search.items, { ...search.items[0], id: '5279134' }] },
    { items: [{ ...search.items[0], league: 'mens-college-basketball' }] }, { items: [] }]) {
    const result = await run([player('beringer', { display_name: 'Joan Beringer', espn_id: null })], {}, { lookup })
    assert.equal(result.unverified, 1)
    assert.equal(result.writes.filter(row => row.path === '/rest/v1/players').length, 0)
  }
})

Deno.test('a provider ID already owned by another player stays untouched', async () => {
  const result = await run([
    player('beringer', { display_name: 'Joan Beringer', espn_id: null }),
    player('owner', { espn_id: '5279133', nba_team: null, career_games_base: 1 }),
  ], {})
  assert.equal(result.unverified, 1)
  assert.equal(result.writes.filter(row => row.path === '/rest/v1/players').length, 0)
})

Deno.test('NBA experience fallback still identifies a no-debut player', async () => {
  const profile = { props: { pageProps: { player: { info: { ...nba.props.pageProps.player.info, SEASON_EXP: 0, GAMES_PLAYED_FLAG: 'N' } } } } }
  const rows = [player('beringer', { nba_id: '1642866', years_exp: null })]
  const result = await run(rows, {}, { profile })
  assert.equal(result.updated, 1)
  assert.equal(result.unverified, 0)
  assert.equal(rows[0].years_exp, 0)
  assert.equal(rows[0].career_games_base, 0)
})

Deno.test('a malformed historical season cannot certify a base', async () => {
  const rows = [player('incomplete')]
  const result = await run(rows, { incomplete: { ...veteran, categories: [{ ...veteran.categories[0], statistics: [{ season: { year: 2020 }, stats: ['--'] }] }] } })
  assert.equal(result.updated, 0)
  assert.equal(result.unverified, 1)
  assert.equal(rows[0].career_games_base, null)
})

Deno.test('a timed-out ESPN response still allows the server to apply a rookie fallback', async () => {
  const rows = [player('rookie', { years_exp: 0 })]
  const result = await run(rows, {}, { stall: true, lookupTimeoutMs: 10 })
  assert.equal(result.updated, 1)
  assert.equal(rows[0].career_games_base, 0)
})

Deno.test('a changed identity before saving is reported and remains retryable', async () => {
  const rows = [player('veteran')]
  const result = await run(rows, { veteran }, { refuseSave: true })
  assert.equal(result.updated, 0)
  assert.match(result.failures[0], /identity changed/)
  assert.equal(rows[0].career_games_base, null)
})

Deno.test('the worker caps a configured large batch at 300 players', async () => {
  const rows = Array.from({ length: 301 }, (_, i) => player(`capped-${String(i).padStart(3, '0')}`))
  const payloads = Object.fromEntries(rows.map(row => [row.id, veteran]))
  const result = await run(rows, payloads, { maxPlayers: 999 })
  assert.equal(result.updated, 300)
  assert.equal(result.unverified, 1)
  assert.equal(result.requests.filter(url => url.hostname === 'career.invalid').length, 300)
})

Deno.test('an ESPN server failure does not retry the career lookup within the same week', async () => {
  const rows = [player('server-failure')]
  const first = await run(rows, {}, { statsStatus: 500 })
  assert.equal(first.requests.filter(url => url.hostname === 'career.invalid').length, 1)
  const nextDay = await run(rows, {}, { statsStatus: 500, at: new Date('2026-10-26T16:00:00Z') })
  assert.equal(nextDay.requests.filter(url => url.hostname === 'career.invalid').length, 0)
})

Deno.test('a stale ESPN total cannot become the completed-season base', async () => {
  const rows = [player('stale', { years_exp: 2, career_regular_season_games: 100 })]
  const payload = { filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
    categories: [{ names: ['gamesPlayed'], totals: ['100'], statistics: [
      { season: { year: 2026 }, stats: ['99'] }, { season: { year: 2027 }, stats: ['1'] },
    ] }] }
  const result = await run(rows, { stale: payload })
  assert.equal(rows[0].career_games_base, 99)
  assert.equal(result.writes.filter(write => Object.hasOwn(write.body, 'career_regular_season_games')).length, 0)
})
