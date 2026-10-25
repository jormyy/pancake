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
