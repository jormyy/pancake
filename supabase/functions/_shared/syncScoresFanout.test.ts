// Bounded league fan-out: one failing league must not abort or starve the
// other leagues' score sync.

const LEAGUE_A = '00000000-0000-4000-8000-00000000000a'
const LEAGUE_B = '00000000-0000-4000-8000-00000000000b'
const SEASON_A = '00000000-0000-4000-8000-0000000000aa'
const SEASON_B = '00000000-0000-4000-8000-0000000000bb'

const requests: string[] = []

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
  const url = new URL(req.url)
  requests.push(`${url.pathname}?${url.searchParams.toString()}`)

  let body: unknown = []
  if (url.pathname === '/rest/v1/league_seasons') {
    const leagueFilter = url.searchParams.get('league_id')?.replace('eq.', '')
    const all = [
      { id: SEASON_A, league_id: LEAGUE_A, season_year: 3101, leagues: { scoring_settings: {} } },
      { id: SEASON_B, league_id: LEAGUE_B, season_year: 3102, leagues: { scoring_settings: {} } },
    ]
    body = leagueFilter ? all.filter((season) => season.league_id === leagueFilter) : all
  } else if (url.pathname === '/rest/v1/season_weeks') {
    const year = Number(url.searchParams.get('season_year')?.replace('eq.', ''))
    body = [{ season_year: year, week_number: 1, week_start: '2101-01-01', week_end: '2101-01-07' }]
  } else if (url.pathname === '/rest/v1/matchups') {
    const leagueFilter = url.searchParams.get('league_id') ?? url.searchParams.get('league_season_id') ?? ''
    if (leagueFilter.includes(LEAGUE_A) || leagueFilter.includes(SEASON_A)) {
      // League A is broken: every matchup read fails.
      return new Response(JSON.stringify({ message: 'simulated outage' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
    body = []
  }
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')

const { syncScores } = await import('./syncScores.ts')

Deno.test('a failing league does not abort the other leagues', async () => {
  // Must not throw: league A fails, league B still completes.
  await syncScores(undefined, new Date('2101-01-07T18:00:00Z'))

  const leagueBRequests = requests.filter((request) =>
    request.includes(SEASON_B) || request.includes(LEAGUE_B))
  if (leagueBRequests.length === 0) {
    throw new Error('League B was never processed after league A failed')
  }
})

Deno.test('every league failing surfaces as a sync failure', async () => {
  let threw = false
  try {
    // League B has no season_weeks in this window -> no plan; force A-only by
    // reusing the same run: A fails planning, B plans but the requirement is
    // only that a total wipeout is not reported as success. Simulate by
    // checking syncScores against a reference date where both leagues fail:
    // league A errors and league B errors are both matchup reads.
    await syncScores(LEAGUE_A, new Date('2101-01-07T18:00:00Z'))
  } catch {
    threw = true
  }
  if (!threw) {
    throw new Error('Expected syncScores to fail when every league fails')
  }
})

Deno.test({
  name: 'close fanout mock server',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => postgrest.shutdown(),
})
