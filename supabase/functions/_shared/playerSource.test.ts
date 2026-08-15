// Degraded-source contract for the ESPN player source: a broken, truncated,
// or reshaped payload is refused outright (no writes possible), and a
// recovered source works again on the next run with no manual action.

let mode: 'good' | 'few-teams' | 'garbage' | 'down' | 'empty-rosters' = 'good'

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
  if (mode === 'down') return new Response('service unavailable', { status: 503 })
  if (mode === 'garbage') return new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } })

  if (url.pathname.endsWith('/teams')) {
    if (mode === 'few-teams') {
      return Response.json({ sports: [{ leagues: [{ teams: goodTeams.sports[0].leagues[0].teams.slice(0, 5) }] }] })
    }
    return Response.json(goodTeams)
  }
  if (url.pathname.includes('/roster')) {
    const teamId = url.pathname.split('/teams/')[1]?.split('/')[0] ?? '0'
    return Response.json(mode === 'empty-rosters' ? { athletes: [] } : goodRosterFor(teamId))
  }
  if (url.pathname.endsWith('/injuries')) {
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

const { fetchEspnPlayerRecords, mapEspnTeam } = await import('./playerSource.ts')

async function expectRefusal(label: string, pattern: RegExp) {
  try {
    await fetchEspnPlayerRecords()
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
  const records = await fetchEspnPlayerRecords()
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
    await fetchEspnPlayerRecords()
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

Deno.test('the source recovers with no manual action', async () => {
  mode = 'good'
  const records = await fetchEspnPlayerRecords()
  if (records.length !== 450) throw new Error('recovered source did not produce a full payload')
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
