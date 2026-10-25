import { strict as assert } from 'node:assert'
import { careerRegularSeasonGames } from '../_shared/careerGames.ts'

Deno.test({
  name: 'private database career recount matches ESPN history and avoids repeated lookups',
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
      if (path === '/athletes/current-free/stats' || path === '/athletes/historical-free/stats') return Response.json(career)
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
    const gameIds: string[] = []
    let userId: string | null = null
    const leagueId = crypto.randomUUID()
    const now = new Date('2026-10-25T16:00:00Z')
    try {
      const empty = await supabase.from('players').select('id', { count: 'exact', head: true })
      assert.ifError(empty.error)
      assert.equal(empty.count, 0, 'Use an empty private data stack')
      const created = await supabase.from('players').insert([
        { first_name: 'Joan', last_name: 'Beringer', nba_id: '1642866', espn_id: '5279133', nba_team: 'MIN', years_exp: null, injury_status: 'Out' },
        { first_name: 'Henri', last_name: 'Veesaar', espn_id: '5105571', nba_team: 'BOS', years_exp: 0 },
        { first_name: 'Unlinked', last_name: 'Player', nba_team: 'BOS', injury_status: 'Out', years_exp: 1, career_games_prior: 0, career_regular_season_games: 42, career_games_checked_at: now.toISOString() },
        { first_name: 'Unknown', last_name: 'Rookie', espn_id: 'rookie-missing', nba_team: 'BOS', years_exp: 0 },
        { first_name: 'Unavailable', last_name: 'Veteran', espn_id: '404', nba_team: 'BOS', years_exp: 10, career_regular_season_games: 64 },
      ]).select('id')
      assert.ifError(created.error)
      ids.push(...created.data!.map(row => row.id))
      const games = await supabase.from('nba_games').insert(Array.from({ length: 42 }, (_, index) => ({
        nba_game_id: `002${index < 40 ? '25' : '26'}${String(index + 3000).padStart(5, '0')}`,
        game_date: new Date(Date.UTC(index < 40 ? 2025 : 2026, 9, 22 + (index < 40 ? index * 3 : index - 40))).toISOString().slice(0, 10),
        season_year: index < 40 ? 2026 : 2027, week_number: 1, home_team: 'MIN', away_team: 'BOS', status: 'Final',
      }))).select('id, season_year')
      assert.ifError(games.error)
      gameIds.push(...games.data!.map(row => row.id))
      const stats = await supabase.from('player_game_stats').insert(games.data!.map(game => ({
        player_id: ids[0], game_id: game.id, season_year: game.season_year, week_number: 1, minutes_played: 12, did_not_play: false,
      })))
      assert.ifError(stats.error)
      const mapped = await syncNBAIds(now)
      assert.deepEqual(mapped.failures, [])
      const result = await syncCareerGames(now)
      assert.equal(result.updated, 0)
      assert.deepEqual(result.failures, [])
      assert.equal(result.unverified, 1)
      const rows = await supabase.from('players').select('display_name, espn_id, years_exp, injury_status, career_regular_season_games, career_games_checked_at').in('id', ids).order('display_name')
      assert.ifError(rows.error)
      assert.deepEqual(rows.data!.map(row => [row.display_name, row.espn_id, row.years_exp, row.career_regular_season_games, row.injury_status]), [
        ['Henri Veesaar', '5105571', 0, 0, null], ['Joan Beringer', '5279133', 1, 42, 'Out'], ['Unavailable Veteran', '404', 10, 64, null],
        ['Unknown Rookie', 'rookie-missing', 0, 0, null], ['Unlinked Player', null, 1, 42, 'Out'],
      ])
      assert.equal(rows.data!.find(row => row.espn_id === '404')!.career_games_checked_at, null)
      assert.equal(rows.data!.find(row => row.espn_id === '5279133')!.career_regular_season_games, careerRegularSeasonGames(career))
      assert.ok(!calls.includes('/athletes/5279133/stats'))
      console.log('PASS: 40 prior-season and two current-season played boxes equal the pinned ESPN career total of 42')
      console.log('PASS: unavailable career data preserves the stored count and leaves its checked time unchanged')
      const before = calls.length
      const repeated = await syncCareerGames(now)
      assert.equal(repeated.updated, 0)
      assert.deepEqual(repeated.failures, [])
      assert.equal(repeated.unverified, 0)
      assert.deepEqual(calls.slice(before), [])
      console.log('PASS: same-day calls fetch no career data, including the failed lookup')
      const user = await supabase.auth.admin.createUser({ email: `${leagueId}@example.test`, password: `Local-${leagueId}!`, email_confirm: true,
        user_metadata: { username: `career_${leagueId.slice(0, 8)}` } })
      assert.ifError(user.error)
      userId = user.data.user!.id
      const league = await supabase.from('leagues').insert({ id: leagueId, name: 'Career coverage', slug: leagueId, commissioner_id: userId, status: 'offseason' })
      assert.ifError(league.error)
      const member = await supabase.from('league_members').insert({ league_id: leagueId, user_id: userId, role: 'commissioner' }).select('id').single()
      assert.ifError(member.error)
      const seasons = await supabase.from('league_seasons').insert([
        { league_id: leagueId, season_year: 2027, is_current: true }, { league_id: leagueId, season_year: 2026, is_current: false },
      ]).select('id, is_current')
      assert.ifError(seasons.error)
      const freeAgents = await supabase.from('players').insert([
        { first_name: 'Current', last_name: 'Free Agent', espn_id: 'current-free', years_exp: 10 },
        { first_name: 'Historical', last_name: 'Free Agent', espn_id: 'historical-free', years_exp: 10 },
      ]).select('id, espn_id')
      assert.ifError(freeAgents.error)
      ids.push(...freeAgents.data!.map(row => row.id))
      const rosters = await supabase.from('roster_players').insert(freeAgents.data!.map(row => ({
        league_id: leagueId, member_id: member.data!.id, player_id: row.id, acquired_via: 'draft',
        league_season_id: seasons.data!.find(season => season.is_current === (row.espn_id === 'current-free'))!.id,
      })))
      assert.ifError(rosters.error)
      const rosterCalls = calls.length
      const current = await syncCareerGames(now)
      assert.equal(current.updated, 1)
      assert.deepEqual(current.failures, [])
      assert.equal(current.unverified, 0)
      assert.ok(calls.slice(rosterCalls).includes('/athletes/current-free/stats'))
      assert.ok(!calls.slice(rosterCalls).includes('/athletes/historical-free/stats'))
      const historical = await supabase.from('players').select('career_regular_season_games, career_games_checked_at').eq('espn_id', 'historical-free').single()
      assert.ifError(historical.error)
      assert.deepEqual(historical.data, { career_regular_season_games: null, career_games_checked_at: null })
      console.log('PASS: current rosters fill free-agent career gaps; historical rosters do not trigger a lookup')
      const unlisted = await supabase.from('players').insert({ first_name: 'Joan', last_name: 'Beringer Jr.', espn_id: 'unlisted', nba_team: null, injury_status: 'Out', years_exp: 1 }).select('id').single()
      assert.ifError(unlisted.error)
      ids.push(unlisted.data!.id)
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
      const excluded = await supabase.from('players').select('injury_status').in('display_name', ['Joan Beringer Jr.', 'Unlinked Player'])
      assert.ifError(excluded.error)
      assert.deepEqual(excluded.data, [{ injury_status: 'Out' }, { injury_status: 'Out' }])
      const retained = await supabase.from('players').select('injury_status').eq('espn_id', '5279133').single()
      assert.ifError(retained.error)
      assert.equal(retained.data?.injury_status, 'Out')
      console.log('PASS: an afternoon scratch changes only the injury; unchanged and degraded feeds keep the stored result')
    } finally {
      const league = await supabase.from('leagues').delete().eq('id', leagueId)
      assert.ifError(league.error)
      if (ids.length > 0) {
        const stats = await supabase.from('player_game_stats').delete().in('player_id', ids)
        assert.ifError(stats.error)
        const { error } = await supabase.from('players').delete().in('id', ids)
        assert.ifError(error)
      }
      const removedGames = await supabase.from('nba_games').delete().in('id', gameIds)
      assert.ifError(removedGames.error)
      if (userId) {
        const user = await supabase.auth.admin.deleteUser(userId)
        assert.ifError(user.error)
      }
      await upstream.shutdown()
    }
  },
})
