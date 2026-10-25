import { strict as assert } from 'node:assert'

Deno.test({
  name: 'private database import and schedule receipts',
  ignore: Deno.env.get('PANCAKE_DATA_DB_TESTS') !== '1',
  fn: async () => {
    const api = new URL(Deno.env.get('SUPABASE_URL')!)
    const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
    for (const target of [api, db]) assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Use a private local stack')
    const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url))
    const port = (section: string) => config.match(new RegExp(`^\\[${section}\\]\n(?:(?!\\[)[^\n]*\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
    assert.equal(api.port, port('api'))
    assert.equal(db.port, port('db'))
    const { supabase } = await import('../_shared/supabase.ts')
    const { resolvePlayerImports } = await import('../_shared/playerImports.ts')
    const { buildScheduleSyncPlan } = await import('../_shared/schedule.ts')
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const first = `Coverage${suffix}`
    let playerId: string | null = null
    const season = 2071
    const gameIds = ['0027000001', '0027000002']

    try {
      const plan = buildScheduleSyncPlan(gameIds.map((gameId, index) => ({
        gameId, gameDate: `2070-10-${25 + index}`, homeTeam: 'BOS', awayTeam: 'NYK', status: 'Scheduled',
        startedAt: `2070-10-${25 + index}T23:00:00Z`, weekNumber: 1, scheduleSeasonYear: '2070-71',
      })), new Date('2070-10-25T16:00:00Z'), true)
      for (const expected of [1, 0]) {
        const published = await supabase.rpc('publish_nba_schedule_atomic', {
          p_season_year: plan.seasonYear!, p_games: plan.rows, p_weeks: plan.weeks,
        })
        assert.ifError(published.error)
        assert.equal(published.data, expected)
      }
      const games = await supabase.from('nba_games').select('nba_game_id').in('nba_game_id', gameIds)
      assert.ifError(games.error)
      assert.equal(games.data?.length, 2)
      console.log('PASS: schedule RPC publishes two games and returns one changed week, then zero on repeat')

      const result = await resolvePlayerImports('espn', [{ provider_id: suffix, first_name: first, last_name: 'Fixture',
        metadata: { nba_team: 'BOS', position: 'PG', eligible_positions: ['PG'], status: 'Active', years_exp: 1, injury_status: 'Out' } }])
      playerId = result.results[0].player_id
      assert.ok(playerId)
      await resolvePlayerImports('espn', [{ provider_id: suffix, first_name: first, last_name: 'Fixture',
        metadata: { nba_team: 'LAL', position: 'PG', eligible_positions: ['PG'], status: 'Active', years_exp: 1 } }])
      const { data, error } = await supabase.from('players').select('nba_team, injury_status').eq('id', playerId).single()
      assert.ifError(error)
      assert.deepEqual(data, { nba_team: 'LAL', injury_status: 'Out' })
      console.log('PASS: full import changes player metadata while an omitted injury key preserves Out')
      await resolvePlayerImports('espn', [{ provider_id: suffix, first_name: first, last_name: 'Fixture',
        metadata: { nba_team: 'LAL', position: 'PG', eligible_positions: ['PG'], status: 'Active', years_exp: 1, injury_status: null } }])
      const cleared = await supabase.from('players').select('injury_status').eq('id', playerId).single()
      assert.ifError(cleared.error)
      assert.equal(cleared.data?.injury_status, null)
      console.log('PASS: an explicit null injury key clears the stored designation')
    } finally {
      if (playerId) {
        const { error } = await supabase.from('players').delete().eq('id', playerId)
        assert.ifError(error)
      }
      const removed = await supabase.from('nba_games').delete().in('nba_game_id', gameIds)
      assert.ifError(removed.error)
      const weeks = await supabase.from('season_weeks').delete().eq('season_year', season)
      assert.ifError(weeks.error)
    }
  },
})

Deno.test({
  name: 'private database full imports preserve injuries through malformed and unavailable injury feeds',
  ignore: Deno.env.get('PANCAKE_DATA_DB_TESTS') !== '1',
  fn: async () => {
    const api = new URL(Deno.env.get('SUPABASE_URL')!)
    const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
    for (const target of [api, db]) assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Use a private local stack')
    const suffix = crypto.randomUUID().replaceAll('-', '')
    const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
      'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
    const athletes = Array.from({ length: 360 }, (_, index) => ({
      id: `full-${suffix}-${index}`, firstName: `Full${suffix}`, lastName: `Player${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`,
      experience: { years: index === 0 ? 0 : 1 }, position: { abbreviation: 'PG' }, status: { type: 'active' },
    }))
    let injuryMode = 'malformed'
    const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
      const url = new URL(request.url)
      if (url.pathname === '/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map((abbreviation, index) => ({ team: { id: String(index), abbreviation } })) }] }] })
      const team = url.pathname.match(/^\/teams\/(\d+)\/roster$/)?.[1]
      if (team) return Response.json({ athletes: athletes.slice(Number(team) * 12, Number(team) * 12 + 12) })
      if (url.pathname === '/injuries') return injuryMode === 'http'
        ? new Response('unavailable', { status: 500 })
        : Response.json({ injuries: [{ injuries: [{ status: 'Out', athlete: { displayName: 'Other Player' } }, { status: 'Out' }] }] })
      if (url.pathname === '/news') return Response.json({ articles: [] })
      if (url.pathname === '/players/nba') return Response.json(Object.fromEntries(athletes.map((athlete, index) => [String(700000 + index), {
        player_id: String(700000 + index), sport: 'nba', first_name: athlete.firstName, last_name: athlete.lastName, team: codes[Math.floor(index / 12)], years_exp: athlete.experience.years, position: 'PG',
      }])))
      if (url.pathname === '/staticData/playerIndex.json') return Response.json({ resultSets: [{
        headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS', 'TEAM_ABBREVIATION', 'POSITION', 'FROM_YEAR'],
        rowSet: athletes.map((athlete, index) => [900000 + index, athlete.firstName, athlete.lastName, 1,
          ({ GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' } as Record<string, string>)[codes[Math.floor(index / 12)]] ?? codes[Math.floor(index / 12)], 'PG', 2026 - athlete.experience.years]),
      }] })
      return new Response('unavailable', { status: 404 })
    })
    const base = `http://127.0.0.1:${upstream.addr.port}`
    Deno.env.set('PLAYER_SYNC_SOURCE', 'espn')
    Deno.env.set('ESPN_SITE_BASE_URL', base)
    Deno.env.set('ESPN_CAREER_BASE_URL', base)
    Deno.env.set('NBA_CDN_BASE_URL', base)
    Deno.env.set('SLEEPER_BASE_URL', base)
    Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'private-data-test')
    type Handler = (request: Request) => Promise<Response>
    let handler: Handler | undefined
    const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
    Object.defineProperty(Deno, 'serve', { value: (callback: Handler) => { handler = callback } })
    try { await import('./index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
    const { supabase } = await import('../_shared/supabase.ts')
    const { resolvePlayerImports } = await import('../_shared/playerImports.ts')
    try {
      await resolvePlayerImports('espn', [{ provider_id: athletes[0].id, first_name: athletes[0].firstName, last_name: athletes[0].lastName,
        metadata: { nba_team: 'BOS', years_exp: 0, injury_status: 'Out' } }])
      const rookieBase = await supabase.rpc('complete_player_career_base_atomic', {
        p_player_id: (await supabase.from('players').select('id').eq('espn_id', athletes[0].id).single()).data!.id,
        p_espn_id: athletes[0].id, p_nba_id: '', p_season_year: 2027,
      })
      assert.ifError(rookieBase.error)
      assert.equal(rookieBase.data, true)
      for (injuryMode of ['malformed', 'http']) {
        const response = await handler!(new Request('http://function.invalid', { method: 'POST', headers: { 'x-internal-function-token': 'private-data-test' }, body: JSON.stringify({ mode: 'injuries' }) }))
        const result = await response.json()
        assert.equal(response.status, 200, JSON.stringify(result))
        assert.equal(result.ok, true)
        assert.equal(result.injuryWarnings, 1)
        assert.equal(result.careerUnverified, 359)
        assert.equal(result.updated + result.inserted, 360)
        const connected = await supabase.from('players').select('nba_id,sleeper_id,position,years_exp').eq('first_name', athletes[0].firstName)
        assert.ifError(connected.error)
        assert.equal(connected.data?.length, 360)
        assert.ok(connected.data!.every(row => row.nba_id && row.sleeper_id && row.position && row.years_exp != null))
        const imported = await supabase.from('players').select('nba_team, injury_status, years_exp, career_regular_season_games').eq('espn_id', athletes[0].id).single()
        assert.ifError(imported.error)
        assert.deepEqual(imported.data, { nba_team: 'ATL', injury_status: 'Out', years_exp: 0, career_regular_season_games: 0 })
      }
    } finally {
      const removed = await supabase.from('players').delete().eq('first_name', athletes[0].firstName)
      assert.ifError(removed.error)
      await upstream.shutdown()
    }
  },
})
