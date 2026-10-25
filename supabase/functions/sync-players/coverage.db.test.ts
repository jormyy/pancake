import { strict as assert } from 'node:assert'

Deno.test({
  name: 'private database player coverage and daily refresh',
  ignore: Deno.env.get('PANCAKE_DATA_DB_TESTS') !== '1',
  fn: async () => {
    const api = new URL(Deno.env.get('SUPABASE_URL')!)
    const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
    for (const target of [api, db]) assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Use a private local stack')
    const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url))
    const port = (section: string) => config.match(new RegExp(`^\\[${section}\\]\n(?:(?!\\[)[^\n]*\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
    assert.equal(api.port, port('api'))
    assert.equal(db.port, port('db'))
    const fixture = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(`./fixtures/${name}.json`, import.meta.url)))
    const index = await fixture('nba-index-beringer')
    const search = await fixture('espn-search-beringer')
    const career = await fixture('espn-career-beringer')
    const rookie = await fixture('espn-no-nba-games')
    const calls: string[] = []
    let injuries: unknown = { injuries: [{ injuries: [{ status: 'Out', athlete: { displayName: 'Joan Beringer' } }] }] }
    const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
      const path = new URL(request.url).pathname
      calls.push(path)
      if (path === '/staticData/playerIndex.json') return Response.json(index)
      if (path === '/injuries') return Response.json(injuries)
      if (path === '/search') return Response.json(search)
      if (path === '/athletes/5279133/stats') return Response.json(career)
      if (path === '/athletes/5105571/stats') return Response.json(rookie)
      return new Response('Unavailable', { status: 404 })
    })
    const base = `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}`
    Deno.env.set('NBA_CDN_BASE_URL', base)
    Deno.env.set('ESPN_SITE_BASE_URL', base)
    Deno.env.set('ESPN_CAREER_BASE_URL', base)
    Deno.env.set('ESPN_SEARCH_BASE_URL', `${base}/search`)
    Deno.env.set('NBA_COM_BASE_URL', base)
    const { supabase } = await import('../_shared/supabase.ts')
    const { syncCareerGames } = await import('./career.ts')
    const { syncNBAIds } = await import('./nbaIds.ts')
    const { syncInjuries } = await import('./injuries.ts')
    const ids: string[] = []
    const now = new Date('2026-10-25T16:00:00Z')
    try {
      const empty = await supabase.from('players').select('id', { count: 'exact', head: true })
      assert.ifError(empty.error)
      assert.equal(empty.count, 0, 'Use an empty private data stack')
      const created = await supabase.from('players').insert([
        { first_name: 'Joan', last_name: 'Beringer', nba_id: '1642866', nba_team: 'MIN', years_exp: null, injury_status: 'Out' },
        { first_name: 'Henri', last_name: 'Veesaar', espn_id: '5105571', nba_team: 'BOS', years_exp: 0 },
        { first_name: 'Unavailable', last_name: 'Veteran', espn_id: '404', nba_team: 'BOS', years_exp: 1, career_regular_season_games: 64 },
      ]).select('id')
      assert.ifError(created.error)
      ids.push(...created.data!.map(row => row.id))
      const mapped = await syncNBAIds(now)
      assert.deepEqual(mapped.failures, [])
      const result = await syncCareerGames(now)
      assert.equal(result.updated, 2)
      assert.equal(result.failures.length, 1)
      const rows = await supabase.from('players').select('display_name, espn_id, years_exp, injury_status, career_regular_season_games, career_games_checked_at').in('id', ids).order('display_name')
      assert.ifError(rows.error)
      assert.deepEqual(rows.data!.map(row => [row.display_name, row.espn_id, row.years_exp, row.career_regular_season_games, row.injury_status]), [
        ['Henri Veesaar', '5105571', 0, 0, null], ['Joan Beringer', '5279133', 1, 42, 'Out'], ['Unavailable Veteran', '404', 1, 64, null],
      ])
      assert.equal(rows.data!.find(row => row.espn_id === '404')!.career_games_checked_at, null)
      console.log('PASS: missing ESPN identity, missing experience and no-debut totals fill from pinned sources; existing injury survives')
      console.log('PASS: unavailable career data preserves the stored count and leaves its checked time unchanged')
      const before = calls.length
      const repeated = await syncCareerGames(now)
      assert.equal(repeated.updated, 0)
      assert.equal(repeated.failures.length, 1)
      assert.deepEqual(calls.slice(before), ['/athletes/404/stats'])
      console.log('PASS: a same-day retry fetches only the unresolved player')
      const beringer = rows.data!.find(row => row.espn_id === '5279133')!
      const morning = await supabase.from('players').update({ injury_status: null }).eq('espn_id', '5279133')
      assert.ifError(morning.error)
      const afternoon = await syncInjuries()
      assert.deepEqual(afternoon, { updated: 1, failure: null })
      const refreshed = await supabase.from('players').select('years_exp, injury_status, career_regular_season_games').eq('espn_id', '5279133').single()
      assert.ifError(refreshed.error)
      assert.deepEqual(refreshed.data, { years_exp: beringer.years_exp, injury_status: 'Out', career_regular_season_games: beringer.career_regular_season_games })
      assert.deepEqual(await syncInjuries(), { updated: 0, failure: null })
      injuries = { injuries: [] }
      const degraded = await syncInjuries()
      assert.equal(degraded.updated, 0)
      assert.match(degraded.failure ?? '', /injury_status unchanged/)
      const retained = await supabase.from('players').select('injury_status').eq('espn_id', '5279133').single()
      assert.ifError(retained.error)
      assert.equal(retained.data?.injury_status, 'Out')
      console.log('PASS: an afternoon scratch changes only the injury; unchanged and degraded feeds keep the stored result')
    } finally {
      if (ids.length > 0) {
        const { error } = await supabase.from('players').delete().in('id', ids)
        assert.ifError(error)
      }
      await upstream.shutdown()
    }
  },
})
