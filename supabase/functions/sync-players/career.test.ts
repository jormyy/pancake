import { strict as assert } from 'node:assert'

for (const [key, value] of Object.entries({
  SUPABASE_URL: 'http://database.invalid', PANCAKE_SUPABASE_SECRET_KEY: 'fixture-key',
  ESPN_CAREER_BASE_URL: 'http://career.invalid', ESPN_SEARCH_BASE_URL: 'http://search.invalid', NBA_COM_BASE_URL: 'http://nba.invalid',
})) Deno.env.set(key, value)

const fixture = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}.json`, import.meta.url)))
const beringer = await fixture('espn-career-beringer')
const noGames = await fixture('espn-no-nba-games')
const search = await fixture('espn-search-beringer')
const nba = await fixture('nba-profile-beringer')
const athlete = await fixture('espn-athlete-beringer')
const { syncCareerGames } = await import('./career.ts')
const player = (id: string, fields: Record<string, unknown> = {}) => ({
  id, espn_id: id, display_name: `Fixture ${id}`, nba_id: null, nba_team: 'BOS', years_exp: 1,
  career_regular_season_games: null, career_games_checked_at: null, ...fields,
})

async function run(players: ReturnType<typeof player>[], payloads: Record<string, unknown>, rostered: string[] = [], lookup: unknown = search, profile: unknown = nba) {
  const originalFetch = globalThis.fetch
  const writes: { id: string | null; body: Record<string, unknown> }[] = []
  const requests: URL[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(url)
    if (url.hostname === 'nba.invalid') return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(profile)}</script>`)
    if (url.hostname === 'search.invalid') return Response.json(lookup)
    if (url.hostname === 'career.invalid') {
      const stats = url.pathname.endsWith('/stats')
      if (stats) assert.equal(url.searchParams.get('seasontype'), '2')
      const id = `${stats ? '' : 'profile:'}${url.pathname.split('/')[2]}`
      return Object.hasOwn(payloads, id) ? Response.json(payloads[id]) : new Response('missing', { status: 404 })
    }
    assert.equal(url.hostname, 'database.invalid', url.href)
    if (url.pathname === '/rest/v1/roster_players') return Response.json(rostered.map((player_id, index) => ({ id: String(index), player_id })))
    assert.equal(url.pathname, '/rest/v1/players')
    if (request.method === 'PATCH') {
      const body = await request.json()
      writes.push({ id: url.searchParams.get('id'), body })
      return url.searchParams.has('select') ? Response.json([{ id: url.searchParams.get('id')?.slice(3), ...body }]) : new Response(null, { status: 204 })
    }
    return Response.json(players)
  }
  try {
    const result = await syncCareerGames(new Date('2026-10-25T16:00:00Z'))
    return { ...result, writes, requests }
  } finally {
    globalThis.fetch = originalFetch
  }
}

Deno.test('a missing ESPN id outside current rosters links by a unique NBA identity and fills games and experience', async () => {
  const result = await run([player('beringer', { display_name: 'Joan Beringer', nba_id: '1642866', espn_id: null, years_exp: null })], { '5279133': beringer })
  assert.equal(result.updated, 1)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.writes[0], { id: 'eq.beringer', body: { espn_id: '5279133' } })
  const count = result.writes.find(row => Object.hasOwn(row.body, 'career_regular_season_games'))!
  assert.equal(count.body.career_regular_season_games, 42)
  assert.equal(count.body.years_exp, 1)
  assert.equal(result.requests.filter(url => url.hostname === 'search.invalid').length, 1)
})

Deno.test('an ESPN no-debut response stores zero games for a known rookie', async () => {
  const result = await run([player('rookie', { years_exp: 0 })], { rookie: noGames })
  assert.equal(result.updated, 1)
  assert.deepEqual(result.failures, [])
  assert.equal(result.writes[0]?.body.career_regular_season_games, 0)
})

Deno.test('unavailable or unverified stats preserve counts and checked times and report each gap', async () => {
  const result = await run([
    player('missing', { career_regular_season_games: 64 }), player('postseason', { career_regular_season_games: 65 }),
    player('empty', { career_regular_season_games: 42 }),
  ], { postseason: { ...beringer, filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '3' }] }, empty: noGames })
  assert.equal(result.updated, 0)
  assert.equal(result.failures.length, 3)
  assert.deepEqual(result.writes, [])
  for (const id of ['missing', 'postseason', 'empty']) assert.ok(result.failures.some(failure => failure.startsWith(`${id}:`)))
})

Deno.test('counts refresh daily only for NBA-team players and fill rostered free-agent gaps once', async () => {
  const result = await run([
    player('active'), player('cached', { career_regular_season_games: 42, career_games_checked_at: '2026-10-25T10:00:00Z' }),
    player('unrostered', { nba_team: null }), player('rostered', { nba_team: null }),
    player('rostered-known', { nba_team: null, career_regular_season_games: 42 }),
  ], { active: beringer, rostered: beringer }, ['rostered', 'rostered-known'])
  assert.equal(result.updated, 2)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.requests.filter(url => url.hostname === 'career.invalid').map(url => url.pathname).sort(), ['/athletes/active/stats', '/athletes/rostered/stats'])
  assert.deepEqual(result.writes.map(row => row.id).sort(), ['eq.active', 'eq.rostered'])
})

Deno.test('ambiguous or non-NBA search matches cannot assign a provider id', async () => {
  for (const lookup of [
    { items: [...search.items, { ...search.items[0], id: '5279134' }] },
    { items: [{ ...search.items[0], league: 'mens-college-basketball' }] }, { items: [] },
  ]) {
    const result = await run([player('beringer', { display_name: 'Joan Beringer', espn_id: null })], {}, [], lookup)
    assert.equal(result.updated, 0)
    assert.equal(result.failures.length, 1)
    assert.deepEqual(result.writes, [])
  }
})

Deno.test('a provider id owned by another stored player stays untouched', async () => {
  const result = await run([
    player('beringer', { display_name: 'Joan Beringer', espn_id: null }),
    player('owner', { display_name: 'Another Player', espn_id: '5279133', nba_team: null, career_regular_season_games: 42 }),
  ], {})
  assert.equal(result.updated, 0)
  assert.equal(result.failures.length, 1)
  assert.deepEqual(result.writes, [])
})

Deno.test('NBA no-debut data fills a rostered player even when both ESPN feeds lack the player', async () => {
  const noDebut = { props: { pageProps: { player: { info: { ...nba.props.pageProps.player.info, SEASON_EXP: 0, GAMES_PLAYED_FLAG: 'N' } } } } }
  const result = await run([player('beringer', { display_name: 'Joan Beringer', nba_id: '1642866', espn_id: null, nba_team: null, years_exp: null })], {}, ['beringer'], { items: [] }, noDebut)
  assert.equal(result.updated, 1)
  assert.deepEqual(result.failures, [])
  assert.equal(result.writes.length, 1)
  assert.equal(result.writes[0].body.career_regular_season_games, 0)
  assert.equal(result.writes[0].body.years_exp, 0)
})

for (const displayExperience of ['2nd Season', undefined]) {
  Deno.test(`missing experience falls back to the NBA athlete biography: ${displayExperience ?? 'draft year'}`, async () => {
    const totals = { ...beringer, categories: beringer.categories.map((category: Record<string, unknown>) => ({ ...category, statistics: undefined })) }
    const profile = { ...athlete, athlete: { ...athlete.athlete, displayExperience } }
    const result = await run([player('beringer', { espn_id: '5279133', years_exp: null })], { '5279133': totals, 'profile:5279133': profile })
    assert.equal(result.updated, 1)
    assert.deepEqual(result.failures, [])
    assert.equal(result.writes[0]?.body.years_exp, 1)
    assert.equal(result.writes[0]?.body.career_regular_season_games, 42)
  })
}
