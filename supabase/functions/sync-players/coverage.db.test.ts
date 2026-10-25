import { strict as assert } from 'node:assert'
import { careerRegularSeasonGames } from '../_shared/careerGames.ts'

type CareerCase = {
  name: string; years_exp: number; legacy: number | null; expected: number
  local: [number, number][]; wrong_dnp: boolean; espn: unknown; base_source?: 'coverage'
}

type StoredCareer = { id: string; career_regular_season_games: number | null; career_games_base: number | null; career_games_base_season: number | null; career_games_base_source: string | null }

Deno.test({
  name: 'private database fetches unknown counts and counts below 65 while preserving known veterans',
  ignore: Deno.env.get('PANCAKE_DATA_DB_TESTS') !== '1',
  fn: async () => {
    const api = new URL(Deno.env.get('SUPABASE_URL')!)
    const db = new URL(Deno.env.get('SUPABASE_DB_URL')!)
    for (const target of [api, db]) assert.ok(['localhost', '127.0.0.1'].includes(target.hostname), 'Use a private local stack')
    const cases: CareerCase[] = JSON.parse(await Deno.readTextFile(new URL('./fixtures/career-base-cases.json', import.meta.url)))
    cases.push({ ...cases[4], name: 'Coverage Cam Christie', legacy: null, base_source: 'coverage' })
    cases.push({ name: 'Stale threshold', years_exp: 2, legacy: 64, expected: 65, local: [[2025, 32], [2026, 31], [2027, 2]], wrong_dnp: false,
      espn: { filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
        categories: [{ names: ['gamesPlayed'], totals: ['64'], statistics: [
          { season: { year: 2025 }, stats: ['32'] }, { season: { year: 2026 }, stats: ['31'] }, { season: { year: 2027 }, stats: ['1'] },
        ] }] } })
    const calls: string[] = []
    const upstream = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
      const path = new URL(request.url).pathname
      calls.push(path)
      const index = path.match(/^\/athletes\/base-case-(\d+)\/stats$/)?.[1]
      if (index) return Response.json(cases[Number(index)].espn)
      if (path === '/injuries') return Response.json({ injuries: [{ injuries: [{ status: 'Out', athlete: { displayName: cases[0].name } }] }] })
      return new Response('Unavailable', { status: 404 })
    })
    const base = `http://127.0.0.1:${upstream.addr.port}`
    Deno.env.set('ESPN_SITE_BASE_URL', base)
    Deno.env.set('ESPN_CAREER_BASE_URL', base)
    const { supabase } = await import('../_shared/supabase.ts')
    const { syncCareerGames } = await import('./career.ts')
    const { syncInjuries } = await import('./injuries.ts')
    const ids = cases.map(() => crypto.randomUUID())
    const gameIds: string[] = []
    try {
      const empty = await supabase.from('players').select('id', { count: 'exact', head: true })
      assert.ifError(empty.error)
      assert.equal(empty.count, 0, 'Use an empty private data stack')
      const created = await supabase.from('players').insert(cases.map((test, i) => ({
        id: ids[i], first_name: test.name.split(' ')[0], last_name: test.name.split(' ').slice(1).join(' '),
        espn_id: `base-case-${i}`, nba_team: 'BOS', years_exp: test.years_exp,
        career_regular_season_games: test.legacy, injury_status: i === 0 ? 'Out' : null,
      })))
      assert.ifError(created.error)
      const stats: { player_id: string; game_id: string; season_year: number; week_number: number; minutes_played: number; points: number; did_not_play: boolean }[] = []
      const games = cases.flatMap((test, playerIndex) => test.local.flatMap(([year, count]) => Array.from({ length: count }, (_, i) => {
        const id = crypto.randomUUID()
        gameIds.push(id)
        stats.push({ player_id: ids[playerIndex], game_id: id, season_year: year, week_number: 1,
          minutes_played: test.wrong_dnp && i === 1 ? 0 : 12, points: test.wrong_dnp && i === 1 ? 1 : 0,
          did_not_play: test.wrong_dnp })
        return { id, nba_game_id: `002${String(year - 2001).padStart(2, '0')}${String(gameIds.length + 1000).padStart(5, '0')}`,
          game_date: new Date(Date.UTC(year - 1, 11, 22 + i)).toISOString().slice(0, 10),
          season_year: year, week_number: 1, home_team: 'BOS', away_team: 'MIN', status: 'Final' }
      })))
      assert.ifError((await supabase.from('nba_games').insert(games)).error)
      assert.ifError((await supabase.from('player_game_stats').insert(stats)).error)
      for (const [i, test] of cases.entries()) {
        if (test.base_source !== 'coverage') continue
        const fallback = await supabase.rpc('complete_player_career_base_atomic', {
          p_player_id: ids[i], p_espn_id: `base-case-${i}`, p_nba_id: '', p_season_year: 2027,
        })
        assert.ifError(fallback.error)
        assert.equal(fallback.data, true)
      }
      const before = await supabase.from('players').select('id, career_regular_season_games, career_games_base').in('id', ids)
      assert.ifError(before.error)
      for (const [i, test] of cases.entries()) {
        const record: Pick<StoredCareer, 'id' | 'career_regular_season_games' | 'career_games_base'> = before.data!.find(candidate => candidate.id === ids[i])!
        assert.equal(record.career_regular_season_games, test.base_source === 'coverage' ? 64 : test.legacy, `${test.name}: preserve count before base fetch`)
        assert.equal(record.career_games_base, test.base_source === 'coverage' ? 0 : null)
      }
      const result = await syncCareerGames(new Date('2026-10-25T16:00:00Z'))
      const targets = cases.filter(test => test.legacy == null || test.legacy < 65)
      assert.deepEqual(result, { updated: targets.length, unverified: 0, failures: [] })
      const saved = await supabase.from('players').select('id, career_regular_season_games, career_games_base, career_games_base_season, career_games_base_source, injury_status').in('id', ids)
      assert.ifError(saved.error)
      for (const [i, test] of cases.entries()) {
        const record: StoredCareer = saved.data!.find(candidate => candidate.id === ids[i])!
        const fetched = test.legacy == null || test.legacy < 65
        assert.equal(record.career_regular_season_games, fetched ? test.expected : test.legacy, test.name)
        assert.equal(record.career_games_base_season, fetched ? 2026 : null, test.name)
        assert.equal(record.career_games_base_source, fetched ? 'espn' : null, test.name)
        assert.equal(calls.filter(path => path === `/athletes/base-case-${i}/stats`).length, fetched ? 1 : 0, test.name)
        console.log(`PASS: ${test.name}: ${record.career_regular_season_games} career games`)
      }
      assert.equal(careerRegularSeasonGames(cases[5].espn), 100)
      assert.equal(saved.data!.find(row => row.id === ids[5])!.career_regular_season_games, 100)
      assert.equal(saved.data!.find(row => row.id === ids[8])!.career_regular_season_games, 65)
      const previous = calls.length
      assert.deepEqual(await syncCareerGames(new Date('2027-11-01T16:00:00Z')), { updated: 0, unverified: 0, failures: [] })
      assert.equal(calls.length, previous, 'Successful ESPN bases are never refetched, including next season')
      const correction = stats.find(row => row.player_id === ids[6] && row.minutes_played === 0)!
      assert.ifError((await supabase.from('player_game_stats').update({ points: 0 }).eq('game_id', correction.game_id)).error)
      const corrected = await supabase.from('players').select('career_regular_season_games').eq('id', ids[6]).single()
      assert.ifError(corrected.error)
      assert.equal(corrected.data!.career_regular_season_games, 1)
      assert.ifError((await supabase.from('players').update({ injury_status: null }).eq('id', ids[0])).error)
      assert.deepEqual(await syncInjuries(), { updated: 1, failure: null })
      const injury = await supabase.from('players').select('injury_status, career_regular_season_games').eq('id', ids[0]).single()
      assert.ifError(injury.error)
      assert.deepEqual(injury.data, { injury_status: 'Out', career_regular_season_games: 331 })
    } finally {
      assert.ifError((await supabase.from('player_game_stats').delete().in('player_id', ids)).error)
      assert.ifError((await supabase.from('players').delete().in('id', ids)).error)
      for (let offset = 0; offset < gameIds.length; offset += 100) {
        assert.ifError((await supabase.from('nba_games').delete().in('id', gameIds.slice(offset, offset + 100))).error)
      }
      await upstream.shutdown()
    }
  },
})
