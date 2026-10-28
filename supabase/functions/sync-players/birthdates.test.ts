import { strict as assert } from 'node:assert'

Deno.env.set('SUPABASE_URL', 'http://database.invalid')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'fixture-key')
const { syncSourceBirthdates } = await import('./birthdates.ts')

Deno.test('birthdates resume missing identities and preserve existing dates', async () => {
  const originalFetch = globalThis.fetch
  const players = Array.from({ length: 20 }, (_, index) => ({ id: String(index), display_name: `Player ${index}`,
    sleeper_id: String(index), espn_id: null, birthdate: index === 0 ? '1980-01-01' : null as string | null }))
  const source = players.map(player => ({ player_id: player.sleeper_id, first_name: 'Player', last_name: player.id,
    sport: 'nba', birth_date: '1995-02-03' }))
  const calls: string[] = []
  let fail = true
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.hostname, 'database.invalid')
    assert.equal(url.pathname, '/rest/v1/players')
    assert.equal(request.method, 'PATCH')
    assert.equal(url.searchParams.get('birthdate'), 'is.null')
    const id = url.searchParams.get('id')!.slice(3)
    assert.equal(url.searchParams.get('sleeper_id'), `eq.${id}`)
    assert.equal(url.searchParams.get('display_name'), `eq.Player ${id}`)
    calls.push(id)
    if (id === '8' && fail) return Response.json({ message: 'temporary failure' }, { status: 500 })
    players[Number(id)].birthdate = (await request.json()).birthdate
    return Response.json([{ id }])
  }
  try {
    const first = await syncSourceBirthdates(players, source)
    assert.equal(first.updated, 18)
    assert.equal(first.failures.length, 1)
    const committed = [...calls]
    fail = false
    assert.deepEqual(await syncSourceBirthdates(players, source), { updated: 1, failures: [] })
    assert.deepEqual(calls.slice(committed.length), ['8'])
    assert.equal(players[0].birthdate, '1980-01-01')
    assert.equal(players.filter(player => player.birthdate).length, 20)
  } finally { globalThis.fetch = originalFetch }
})

Deno.test('birthdates reject invalid sources and conflicting identities without writes', async () => {
  const players = [{ id: '1', display_name: 'Known Player', sleeper_id: '1', espn_id: '2', birthdate: null }]
  for (const row of [
    { player_id: '1', first_name: 'Someone', last_name: 'Else', birth_date: '1995-01-01' },
    { player_id: '1', first_name: 'Known', last_name: 'Player', birth_date: '2025-02-29' },
    { player_id: '1', first_name: 'Known', last_name: 'Player', birth_date: '1995-01-01', espn_id: '3' },
  ]) assert.deepEqual(await syncSourceBirthdates(players, [{ ...row, sport: 'nba' }, null]), { updated: 0, failures: [] })
  const valid = { player_id: '1', first_name: 'Known', last_name: 'Player', birth_date: '1995-01-01', sport: 'nba' }
  await assert.rejects(syncSourceBirthdates(players, [valid, valid]), /Duplicate Sleeper birthdate identity/)
  assert.deepEqual(await syncSourceBirthdates(players, [valid], 0), { updated: 0, failures: ['Birthdates: 1 remaining after the time budget'] })
})

Deno.test('profile birthdates verify identities and resume only missing dates', async () => {
  const { syncProfileBirthdates } = await import('./birthdates.ts')
  const originalFetch = globalThis.fetch
  Deno.env.set('NBA_COM_BASE_URL', 'http://profile.invalid')
  Deno.env.set('ESPN_CAREER_BASE_URL', 'http://espn.invalid')
  const players = [
    { id: 'one', display_name: 'Fránçois P.J.', nba_id: '42', espn_id: null, sleeper_id: null, birthdate: null as string | null },
    { id: 'two', display_name: 'Second Player', nba_id: null, espn_id: '7', sleeper_id: null, birthdate: null as string | null },
    { id: 'three', display_name: 'Third Player', nba_id: '43', espn_id: null, sleeper_id: null, birthdate: null as string | null },
  ]
  const calls: string[] = []
  let wrong = true
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    calls.push(url.pathname)
    if (url.hostname === 'profile.invalid') {
      const id = url.pathname.startsWith('/player/42/') ? 42 : wrong ? 44 : 43
      return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { player: { info: { PERSON_ID: id, BIRTHDATE: '1990-01-02T00:00:00' } } } } })}</script>`)
    }
    if (url.hostname === 'espn.invalid') return Response.json({ athlete: { id: '7', displayDOB: '4/3/1992' } })
    assert.equal(url.hostname, 'database.invalid')
    assert.equal(url.searchParams.get('birthdate'), 'is.null')
    assert.ok(url.searchParams.has('nba_id') || url.searchParams.has('espn_id'))
    const id = url.searchParams.get('id')!.slice(3)
    players.find(player => player.id === id)!.birthdate = (await request.json()).birthdate
    return Response.json([{ id }])
  }
  try {
    const first = await syncProfileBirthdates(players, 10000, 0)
    assert.equal(first.updated, 2)
    assert.ok(calls.includes('/player/42/francois-pj'))
    assert.match(first.failures[0], /identity mismatch/)
    assert.equal(players[2].birthdate, null)
    calls.length = 0
    wrong = false
    assert.deepEqual(await syncProfileBirthdates(players, 10000, 0), { updated: 1, failures: [] })
    assert.deepEqual(calls, ['/player/43/third-player', '/rest/v1/players'])
    assert.equal(players[1].birthdate, '1992-03-04')
  } finally { globalThis.fetch = originalFetch }
})

Deno.test('profile birthdates stop when the source limits requests and defer the remaining work', async () => {
  const { syncProfileBirthdates } = await import('./birthdates.ts')
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; return new Response(null, { status: 403 }) }
  const players = ['1', '2'].map(id => ({ id, display_name: id, nba_id: id, espn_id: null, sleeper_id: null, birthdate: null }))
  try {
    const result = await syncProfileBirthdates(players, 10000, 10)
    assert.equal(requests, 1)
    assert.equal(result.updated, 0)
    assert.match(result.failures[0], /NBA profile 403/)
    assert.equal(result.failures[1], 'Birthdate profiles: 1 remaining after the source limited requests')
    requests = 0
    assert.deepEqual(await syncProfileBirthdates(players, 0), { updated: 0, failures: ['Birthdate profiles: 2 remaining after the time budget'] })
    assert.equal(requests, 0)
  } finally { globalThis.fetch = originalFetch }
})
