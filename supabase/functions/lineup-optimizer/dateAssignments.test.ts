Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'test-autoset')
let handler: (request: Request) => Promise<Response>
const serve = Object.getOwnPropertyDescriptor(Deno, 'serve')!
Object.defineProperty(Deno, 'serve', { configurable: true, value: (value: typeof handler) => { handler = value } })
try { await import('./index.ts') } finally { Object.defineProperty(Deno, 'serve', serve) }

for (const mode of ['manual', 'scheduled', 'future-empty', 'playing-replacement', 'locked']) {
  Deno.test(`${mode} date optimizer fills slots and retains unreplaced starters`, async () => {
    const original = globalThis.fetch
    const date = '2099-01-02'
    let assignments: { player_id: string; slot_type: string }[] = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const name = new URL(request.url).pathname.split('/').at(-1)
      if (name === 'leagues') return Response.json({ status: 'active' })
      if (name === 'league_seasons') return Response.json({ season_year: 2099, is_current: true })
      if (name === 'season_weeks') return Response.json([{ season_year: 2099, week_number: 1, week_start: '2098-12-29', week_end: '2099-01-04' }])
      if (name === 'nba_games') return Response.json([{ season_year: 2099, game_date: date, home_team: mode === 'playing-replacement' ? 'BENCH' : 'LOCK', away_team: 'OTHER',
        status: mode === 'locked' ? 'InProgress' : 'Scheduled', game_time: '2099-01-02T22:00:00Z', started_at: null }])
      if (name === 'roster_players') return Response.json([
        { player_id: 'starter', players: { position: 'PF', eligible_positions: ['PF'], nba_team: mode === 'locked' ? 'LOCK' : 'OFF', injury_status: null } },
        { player_id: 'replacement', players: { position: 'PF', eligible_positions: ['PF'], nba_team: 'BENCH', injury_status: null } },
        { player_id: 'guard', players: { position: 'PG', eligible_positions: ['PG'], nba_team: 'OFF', injury_status: null } },
      ])
      if (name === 'lineup_slot_templates') return Response.json([{ slot_type: 'PF', slot_count: 1 }, { slot_type: 'PG', slot_count: 1 }])
      if (name === 'weekly_lineups') return Response.json(mode === 'future-empty' ? [] : [
        { player_id: 'starter', slot_type: 'PF', is_auto_set: false, week_number: 1, players: { nba_team: mode === 'locked' ? 'LOCK' : 'OFF' } },
      ])
      if (name === 'get_league_projection_rows') return Response.json([
        { player_id: 'starter', projection_fantasy_points: 10 },
        { player_id: 'replacement', projection_fantasy_points: 50 },
        { player_id: 'guard', projection_fantasy_points: 20 },
      ])
      if (name === 'auto_set_lineup_service_atomic') {
        assignments = (await request.json()).p_assignments
        return new Response(null, { status: 204 })
      }
      if (name === 'lineup_optimizer_settings') return request.method === 'GET'
        ? Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'member', last_optimized_at: null }])
        : new Response(null, { status: 204 })
      if (name === 'sync_runs') return request.method === 'POST' ? Response.json({ id: 'sync' }) : new Response(null, { status: 204 })
      throw new Error(`Unexpected database request ${name}`)
    }
    try {
      const response = await handler(new Request('http://127.0.0.1:9/lineup-optimizer', {
        method: 'POST', headers: { 'x-internal-function-token': 'test-autoset', 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'scheduled' ? { date } : { mode: 'rest_of_season', dates: [date], leagueId: 'league', leagueSeasonId: 'season', memberId: 'member' }),
      }))
      const body = await response.json()
      if (response.status !== 200 || body.failed !== 0 || body.optimized !== 1) throw new Error(`Date optimization failed: ${JSON.stringify(body)}`)
      if (assignments.length !== 2 || !assignments.some(entry => entry.player_id === 'guard' && entry.slot_type === 'PG')) throw new Error('An eligible no-game slot remains empty.')
      const expected = ['future-empty', 'playing-replacement'].includes(mode) ? 'replacement' : 'starter'
      if (!assignments.some(entry => entry.player_id === expected && entry.slot_type === 'PF')) throw new Error('The wrong PF starts.')
    } finally { globalThis.fetch = original }
  })
}
