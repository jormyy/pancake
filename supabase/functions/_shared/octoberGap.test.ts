// Oct 1–21 season-year gap: currentSeasonYear() flips to the new year on
// Oct 1, up to ~3 weeks before season_weeks/nba_games exist for it. With a
// mocked date of Oct 10 and no new-season data, score syncing must complete
// without erroring and without writing to any season.

const requests: { method: string; path: string }[] = []

const postgrest = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (req) => {
  const url = new URL(req.url)
  requests.push({ method: req.method, path: url.pathname })

  let body: unknown = []
  if (url.pathname === '/rest/v1/league_seasons') {
    // One league already rolled to the new season year; no season_weeks exist
    // for it yet.
    body = [{
      id: '00000000-0000-4000-8000-000000000001',
      league_id: '00000000-0000-4000-8000-000000000002',
      season_year: 2027,
      leagues: { scoring_settings: { points: 1 } },
    }]
  }
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
})

Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${(postgrest.addr as Deno.NetAddr).port}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')

const { syncScores } = await import('./syncScores.ts')
const { runSeasonBoundary } = await import('./seasonBoundary.ts')

Deno.test('syncScores on Oct 10 with no new-season data completes without writes', async () => {
  await syncScores(undefined, new Date('2026-10-10T16:00:00Z'))

  const writes = requests.filter((request) => request.method !== 'GET')
  if (writes.length > 0) {
    throw new Error(`Expected no writes during the Oct gap; saw ${JSON.stringify(writes)}`)
  }
})

Deno.test('season-boundary on Oct 10 reports the league without acting or erroring', async () => {
  requests.length = 0
  const reports = await runSeasonBoundary(new Date('2026-10-10T16:00:00Z'))
  // The mocked league has status undefined (not active/playoffs/offseason),
  // so the boundary must skip it entirely rather than error.
  if (reports.some((report) => report.error)) {
    throw new Error(`Boundary errored during the Oct gap: ${JSON.stringify(reports)}`)
  }
  const writes = requests.filter((request) => request.method !== 'GET')
  if (writes.length > 0) {
    throw new Error(`Expected no boundary writes during the Oct gap; saw ${JSON.stringify(writes)}`)
  }
})

Deno.test({
  name: 'close mocked PostgREST',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => postgrest.shutdown(),
})
