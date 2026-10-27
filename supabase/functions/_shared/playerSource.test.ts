import { strict as assert } from 'node:assert'

// Degraded-source contract for the ESPN player source: a broken, truncated,
// or reshaped payload is refused outright (no writes possible), and a
// recovered source works again on the next run with no manual action.
// Completeness contract: only a listing that covers every NBA team with
// identifiable athletes has no gaps, so only it can release unlisted players.

let draftYear = 2025

let mode: 'good' | 'league' | 'few-teams' | 'garbage' | 'down' | 'empty-rosters' | 'missing-injuries' | 'empty-injuries' | 'reshaped-injuries' | 'unmapped-injuries' | 'missing-experience' | 'season-numbers' | 'malformed-injury' | 'injuries-down' = 'good'

const ESPN_LEAGUE = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']

const goodTeams = {
  sports: [{
    leagues: [{
      teams: Array.from({ length: 30 }, (_, index) => ({
        team: { id: String(index + 1), abbreviation: index === 0 ? 'GS' : `T${index}` },
      })),
    }],
  }],
}

const goodRosterFor = (teamId: string) => ({
  athletes: Array.from({ length: 15 }, (_, index) => ({
    id: `ath-${teamId}-${index}`,
    firstName: `Team${teamId}`,
    lastName: `Player ${index}`,
    fullName: `Team${teamId} Player ${index}`,
    position: { abbreviation: 'G' },
    status: { type: 'active' },
    experience: { years: 3 },
  })),
})

const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
  const url = new URL(req.url)
  if (
    !req.headers.get('user-agent')?.includes('PancakePlayerSync') ||
    req.headers.get('accept') !== 'application/json' ||
    req.headers.get('referer') !== 'https://www.espn.com/'
  ) {
    return new Response('request headers rejected', { status: 403 })
  }
  if (mode === 'down') return new Response('service unavailable', { status: 503 })
  if (mode === 'garbage') return new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } })

  if (url.pathname.endsWith('/teams')) {
    if (mode === 'few-teams') {
      return Response.json({ sports: [{ leagues: [{ teams: goodTeams.sports[0].leagues[0].teams.slice(0, 5) }] }] })
    }
    if (mode === 'league') {
      return Response.json({ sports: [{ leagues: [{ teams: ESPN_LEAGUE.map((abbreviation, index) => ({ team: { id: String(index + 1), abbreviation } })) }] }] })
    }
    return Response.json(goodTeams)
  }
  if (url.pathname.includes('/roster')) {
    const teamId = url.pathname.split('/teams/')[1]?.split('/')[0] ?? '0'
    const roster = goodRosterFor(teamId)
    if (mode === 'missing-experience') {
      const athletes = roster.athletes.map((athlete, index) => ({ ...athlete, experience: undefined,
        ...(index === 0 ? { draft: { year: draftYear } } : index === 1 ? { debutYear: 2024 } : {}),
      }))
      return Response.json({ athletes, season: { year: 2026 } })
    }
    if (mode === 'season-numbers') {
      const seasons = [0, 2, 24]
      return Response.json({ athletes: roster.athletes.map((athlete, index) => ({ ...athlete, experience: { years: seasons[index % 3] } })) })
    }
    return Response.json(mode === 'empty-rosters' ? { athletes: [] } : roster)
  }
  if (url.pathname.endsWith('/injuries')) {
    if (mode === 'injuries-down') return new Response('unavailable', { status: 500 })
    if (mode === 'malformed-injury') return Response.json({ injuries: [{ injuries: [{ status: 'Out', athlete: { displayName: 'Team1 Player 2' } }, { status: 'Out' }] }] })
    if (mode === 'missing-injuries') return Response.json({})
    if (mode === 'empty-injuries') return Response.json({ injuries: [] })
    if (mode === 'reshaped-injuries') return Response.json({ data: [] })
    if (mode === 'season-numbers') {
      return Response.json({ injuries: [{ injuries: [{ status: 'Out', athlete: { id: '77', displayName: 'Season Two', team: { abbreviation: 'BOS' },
        position: { abbreviation: 'G' }, experience: { years: 2 } } }] }] })
    }
    if (mode === 'unmapped-injuries') return Response.json({ injuries: [{ injuries: [{ status: 'Unknown', athlete: { displayName: 'Player' } }] }] })
    return Response.json({
      injuries: [{
        injuries: [
          { status: 'Day-To-Day', athlete: { displayName: 'Team1 Player 1' } },
          { status: 'Out', athlete: { displayName: 'Team1 Player 2' } },
          { status: 'SomethingNew', athlete: { displayName: 'Team1 Player 3' } },
        ],
      }],
    })
  }
  return new Response('not found', { status: 404 })
})

Deno.env.set('ESPN_SITE_BASE_URL', `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}`)

const { espnListingGaps, fetchEspnInjuries, fetchEspnPlayerListing, mapEspnTeam } = await import('./playerSource.ts')

async function expectRefusal(label: string, pattern: RegExp) {
  try {
    await fetchEspnPlayerListing()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!pattern.test(message)) {
      throw new Error(`${label}: refused with unexpected message: ${message}`)
    }
    return
  }
  throw new Error(`${label}: degraded payload was not refused`)
}

Deno.test('a healthy source produces mapped records with name-joined injuries', async () => {
  mode = 'good'
  const { records } = await fetchEspnPlayerListing()
  if (records.length !== 450) throw new Error(`expected 450 records, got ${records.length}`)
  const gsw = records.find((record) => record.nba_team === 'GSW')
  if (!gsw) throw new Error('ESPN GS team code was not mapped to GSW')
  const dtd = records.find((record) => record.injury_status === 'DTD')
  const out = records.find((record) => record.injury_status === 'Out')
  if (!dtd || !out) throw new Error('injury statuses were not joined by name')
  const unknown = records.find((record) => record.injury_status === 'SomethingNew')
  if (unknown) throw new Error('unknown injury status was not filtered')
  const guard = records.find((record) => record.eligible_positions.join() !== 'G')
  if (guard) throw new Error('coarse G position did not map to a G-eligible set')
})

Deno.test({
  name: 'a down source is refused without writes',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    mode = 'down'
    await expectRefusal('down', /ESPN teams 503/)
  },
})

Deno.test('a garbage (non-JSON) payload is refused', async () => {
  mode = 'garbage'
  let threw = false
  try {
    await fetchEspnPlayerListing()
  } catch {
    threw = true
  }
  if (!threw) throw new Error('garbage payload was not refused')
})

Deno.test('a truncated teams payload is refused', async () => {
  mode = 'few-teams'
  await expectRefusal('few-teams', /degraded: 5 teams/)
})

Deno.test({
  name: 'an empty-roster payload is refused (never blanks players)',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    mode = 'empty-rosters'
    await expectRefusal('empty-rosters', /degraded: 0 players/)
  },
})

for (const degraded of ['missing-injuries', 'reshaped-injuries', 'empty-injuries', 'unmapped-injuries', 'malformed-injury', 'injuries-down'] as const) {
  Deno.test(`${degraded} imports all roster records without injury keys and counts a warning`, async () => {
    mode = degraded
    const listing = await fetchEspnPlayerListing()
    assert.equal(listing.records.length, 450)
    assert.ok(listing.records.every(record => !Object.hasOwn(record, 'injury_status')))
    assert.equal(listing.injuryWarnings, 1)
    assert.equal(listing.failure, null)
  })
}

Deno.test('ESPN season numbers become completed seasons', async () => {
  mode = 'season-numbers'
  const { records } = await fetchEspnPlayerListing()
  assert.deepEqual(['ath-1-0', 'ath-1-1', 'ath-1-2'].map(id => records.find(record => record.espn_id === id)?.years_exp), [0, 1, 23])
  const { identities } = await fetchEspnInjuries()
  assert.equal(identities[0]?.years_exp, 1)
})

Deno.test('missing source experience derives a rookie from draft year and a veteran from NBA debut', async () => {
  mode = 'missing-experience'
  const { records } = await fetchEspnPlayerListing()
  assert.equal(records.find(record => record.espn_id === 'ath-1-0')?.years_exp, 0)
  assert.equal(records.find(record => record.espn_id === 'ath-1-1')?.years_exp, 1)
  assert.equal(records.find(record => record.espn_id === 'ath-1-2')?.years_exp, null)
})

Deno.test('a new draft class is rookie data before the NBA season changes', async () => {
  mode = 'missing-experience'
  draftYear = 2026
  try {
    const { records } = await fetchEspnPlayerListing()
    assert.equal(records.find(record => record.espn_id === 'ath-1-0')?.years_exp, 0)
  } finally {
    draftYear = 2025
  }
})

Deno.test('the source recovers with no manual action', async () => {
  mode = 'good'
  const { records } = await fetchEspnPlayerListing()
  if (records.length !== 450) throw new Error('recovered source did not produce a full payload')
})

Deno.test('a listing of every NBA team is complete; any other team set has gaps', async () => {
  mode = 'league'
  const league = await fetchEspnPlayerListing()
  assert.equal(league.records.length, 450)
  assert.deepEqual(league.gaps, [])
  mode = 'good'
  const partial = await fetchEspnPlayerListing()
  assert.equal(partial.records.length, 450, 'gaps do not block the import itself')
  assert.ok(partial.gaps.includes('unexpected team T1') && partial.gaps.includes('missing roster BOS'), partial.gaps.join('; '))
})

const athlete = (id: string | undefined, firstName = 'First', lastName = 'Last') => ({ id, firstName, lastName })
const league = (codes = ESPN_LEAGUE.map(mapEspnTeam)) => codes.map((teamCode) => ({ teamCode, athletes: [athlete(`${teamCode}-1`)] }))

Deno.test('listing gaps name each way a refresh can miss a signed player', () => {
  assert.deepEqual(espnListingGaps(league()), [])
  assert.deepEqual(espnListingGaps(league().filter((roster) => roster.teamCode !== 'MIN')), ['missing roster MIN'])
  assert.deepEqual(espnListingGaps([...league(), { teamCode: 'MIN', athletes: [athlete('again')] }]), ['2 rosters for MIN'])
  assert.deepEqual(espnListingGaps([...league(), { teamCode: 'EST', athletes: [athlete('star')] }]), ['unexpected team EST'])
  assert.deepEqual(espnListingGaps(league().map((roster) => roster.teamCode === 'UTA' ? { ...roster, athletes: [] } : roster)), ['empty roster UTA'])
  assert.deepEqual(espnListingGaps(league().map((roster) => roster.teamCode === 'GSW'
    ? { ...roster, athletes: [...roster.athletes, athlete(undefined), athlete('nameless', '', '')] } : roster)), ['2 unidentified athlete(s) on GSW'])
  assert.equal(espnListingGaps([]).length, 30)
})

Deno.test('team-code mapping covers the divergent abbreviations', () => {
  const expectations: [string, string][] = [
    ['GS', 'GSW'], ['NO', 'NOP'], ['NY', 'NYK'], ['SA', 'SAS'], ['UTAH', 'UTA'], ['WSH', 'WAS'], ['BOS', 'BOS'],
  ]
  for (const [espn, nba] of expectations) {
    if (mapEspnTeam(espn) !== nba) throw new Error(`mapEspnTeam(${espn}) !== ${nba}`)
  }
})

Deno.test({
  name: 'close ESPN mock upstream',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => upstream.shutdown(),
})
