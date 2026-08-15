// NBA CDN degraded modes: a down or garbage source throws before any row can
// be written (sync-schedule/sync-stats only write after a good parse), a
// reshaped payload yields zero games rather than corrupt rows, and the next
// good poll works with no manual action.

let mode: 'good' | 'down' | 'garbage' | 'reshaped' = 'good'

const goodSchedule = {
  leagueSchedule: {
    seasonYear: '2026-27',
    gameDates: [{
      games: [
        {
          gameId: '0022700001',
          gameDateEst: '2026-10-21T00:00:00Z',
          homeTeam: { teamTricode: 'BOS' },
          awayTeam: { teamTricode: 'NYK' },
          gameStatus: 1,
          weekNumber: 1,
        },
        {
          gameId: '0012700001', // preseason: filtered by callers via gameId
          gameDateEst: '2026-10-10T00:00:00Z',
          homeTeam: { teamTricode: 'LAL' },
          awayTeam: { teamTricode: 'GSW' },
          gameStatus: 3,
          weekNumber: null,
        },
      ],
    }],
  },
}

const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => {
  if (mode === 'down') return new Response('cdn unavailable', { status: 503 })
  if (mode === 'garbage') return new Response('<html>Access Denied</html>', { headers: { 'content-type': 'text/html' } })
  if (mode === 'reshaped') return Response.json({ totallyDifferent: true })
  return Response.json(goodSchedule)
})

Deno.env.set('NBA_CDN_BASE_URL', `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}`)

const { fetchSeasonSchedule } = await import('./nba.ts')

Deno.test({
  name: 'a down CDN throws after retry (no rows can be written)',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    mode = 'down'
    let message = ''
    try {
      await fetchSeasonSchedule()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    if (!/CDN 503/.test(message)) throw new Error(`down CDN not surfaced: ${message || 'no error'}`)
  },
})

Deno.test({
  name: 'a garbage (non-JSON) payload throws instead of producing rows',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    mode = 'garbage'
    let threw = false
    try {
      await fetchSeasonSchedule()
    } catch {
      threw = true
    }
    if (!threw) throw new Error('garbage payload did not throw')
  },
})

Deno.test({
  name: 'a reshaped payload yields zero games, never corrupt rows',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    mode = 'reshaped'
    const games = await fetchSeasonSchedule()
    if (games.length !== 0) throw new Error(`reshaped payload produced ${games.length} games`)
  },
})

Deno.test({
  name: 'the next good poll recovers with no manual action',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    mode = 'good'
    const games = await fetchSeasonSchedule()
    if (games.length !== 2) throw new Error(`expected 2 games, got ${games.length}`)
    if (games[0].gameDate !== '2026-10-21') throw new Error('game date parsed incorrectly')
  },
})

Deno.test({
  name: 'close CDN mock upstream',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () => upstream.shutdown(),
})
