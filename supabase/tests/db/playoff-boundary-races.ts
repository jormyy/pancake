import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
const nativeFetch = globalThis.fetch.bind(globalThis)
let intercept: ((url: URL, method: string, response: Response) => Promise<void>) | undefined
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, api, 'Only the isolated database may receive requests')
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const response = await nativeFetch(input, init)
  await intercept?.(url, method, response)
  return response
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
const query = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10)
const failures: string[] = []
const reports: unknown[] = []
try {
  for (const span of [1, 2]) {
    for (const phase of ['automatic', 'rollover']) {
      const token = crypto.randomUUID().replaceAll('-', '')
      const league = crypto.randomUUID(), season = crypto.randomUUID(), game = crypto.randomUUID(), finalGame = crypto.randomUUID()
      const members = Array.from({ length: 4 }, () => crypto.randomUUID())
      const players = Array.from({ length: 4 }, () => crypto.randomUUID())
      const weekIds = Array.from({ length: 5 }, () => crypto.randomUUID())
      const users: string[] = []
      let year = 0, weeksInserted = false, intercepted = 0
      const first = addDays(today, -42), gameDate = addDays(first, 2)
      const readSemis = () => query(supabase.from('matchups')
        .select('id,home_member_id,away_member_id,home_points,away_points,winner_member_id,is_finalized,finalized_at,score_read_started_at,home_max_possible_points,away_max_possible_points')
        .eq('league_season_id', season).eq('matchup_type', 'playoff_semifinal').order('id'))
      try {
        for (let attempt = 0; attempt < 50; attempt++) {
          const candidate = 3000 + crypto.getRandomValues(new Uint32Array(1))[0] % 5000
          const rows = await query(supabase.from('season_weeks').select('id').in('season_year', [candidate, candidate + 1]))
          const seasons = await query(supabase.from('league_seasons').select('id').in('season_year', [candidate, candidate + 1]))
          if (!rows.length && !seasons.length) { year = candidate; break }
        }
        assert.ok(year)
        for (let side = 0; side < 4; side++) {
          const { data, error } = await supabase.auth.admin.createUser({
            email: `playoff-consume-${token}-${side}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
            user_metadata: { username: `consume_${token.slice(0, 12)}_${side}`, display_name: 'Synthetic playoff overlap' },
          })
          if (error) throw new Error(error.message)
          assert.ok(data.user); users.push(data.user.id)
        }
        await query(supabase.from('leagues').insert({ id: league, slug: `consume-${token}`, name: 'Synthetic playoff overlap',
          commissioner_id: users[0], status: 'active', scoring_settings: { points: 1 }, playoff_start_week: 1,
          ...(span === 2 ? { playoff_total_weeks: 5, playoff_round_weeks: [2, 3] } : {}) }))
        await query(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league,
          user_id: users[side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Overlap ${side}` }))))
        await query(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
        await query(supabase.from('season_weeks').insert(weekIds.map((id, index) => ({ id, season_year: year, week_number: index + 1,
          week_start: addDays(first, index * 7), week_end: addDays(first, index * 7 + 6) }))))
        weeksInserted = true
        await query(supabase.from('players').insert(players.map((id, index) => ({ id, first_name: 'Synthetic',
          last_name: `Consume ${token}-${index}`, position: 'PG' as const, eligible_positions: ['PG'], nba_team: 'XCO' }))))
        await query(supabase.from('roster_players').insert(players.map((id, index) => ({ player_id: id,
          member_id: members[index], league_id: league, league_season_id: season, acquired_via: 'draft', acquired_at: `${addDays(first, -7)}T12:00:00Z` }))))
        await query(supabase.from('weekly_lineups').delete().eq('league_id', league))
        await query(supabase.from('nba_games').insert({ id: game, nba_game_id: `002-consume-${token}`, season_year: year,
          week_number: 1, game_date: gameDate, game_time: `${gameDate}T19:00:00Z`, home_team: 'XCO', away_team: 'XCP', status: 'Final', stats_synced_at: new Date().toISOString() }))
        await query(supabase.rpc('generate_playoff_bracket_atomic', { p_league_id: league }))
        if (span === 1) await query(supabase.from('matchups').update({ end_week_number: null }).eq('league_season_id', season))
        const initial = await readSemis()
        const homes = new Set(initial.map((row: any) => row.home_member_id))
        await query(supabase.from('player_game_stats').insert(players.map((id, index) => ({ player_id: id, game_id: game,
          season_year: year, week_number: 1, game_date: gameDate, points: homes.has(members[index]) ? 10 : 5, did_not_play: false }))))
        await query(supabase.from('weekly_lineups').insert(players.map((id, index) => ({ player_id: id,
          member_id: members[index], league_id: league, league_season_id: season, week_number: 1, game_date: gameDate, slot_type: 'PG' as const, is_auto_set: false }))))
        await syncScores(league)
        assert.ok((await readSemis()).every((row: any) => row.winner_member_id === row.home_member_id && Number(row.home_points) === 10 && Number(row.away_points) === 5))
        if (phase === 'automatic') {
          // Synthetic elapsed-grace fixture. The concurrent correction uses the actual scorer timestamp.
          await query(supabase.from('matchups').update({ finalized_at: new Date(Date.now() - 49 * 3600000).toISOString() }).eq('league_season_id', season))
          await query(supabase.from('player_game_stats').update({ points: 20 }).eq('game_id', game)
            .in('player_id', players.filter((_, index) => !homes.has(members[index]))))
          intercept = async (url, method, response) => {
            if (method !== 'GET' || !url.pathname.endsWith('/matchups') ||
              url.searchParams.get('select')?.split(',').includes('finalized_at') !== true ||
              url.searchParams.get('league_season_id') !== `eq.${season}`) return
            intercept = undefined
            assert.equal(response.ok, true)
            const stale = await response.clone().json()
            assert.ok(stale.every((row: any) => Date.now() - Date.parse(row.finalized_at) > 48 * 3600000))
            intercepted++
            await syncScores(league)
            assert.ok((await readSemis()).every((row: any) => row.winner_member_id === row.away_member_id &&
              Date.now() - Date.parse(row.finalized_at) < 60000), 'Actual correction changes the winner and records a new finalization time')
          }
          const boundary = await runSeasonBoundary(new Date(), league)
          assert.equal(intercepted, 1)
          assert.ok(boundary.every((row: any) => !row.error), JSON.stringify(boundary))
          const finals = await query(supabase.from('matchups').select('id,home_member_id,away_member_id').eq('league_season_id', season).eq('matchup_type', 'playoff_final'))
          const report = { span, phase, intercepted, finalsCreated: finals.length, boundary }
          reports.push(report); console.log(JSON.stringify(report))
          assert.equal(finals.length, 1, 'ready rounds advance after the concurrent replay')
          const replayed = await readSemis()
          assert.ok(replayed.every((row: any) => row.winner_member_id === row.away_member_id && Number(row.away_points) === 20))
          assert.deepEqual(new Set([finals[0].home_member_id, finals[0].away_member_id]),
            new Set(replayed.map((row: any) => row.winner_member_id)), 'the next round uses corrected winners')
        } else {
          await query(supabase.rpc('advance_playoff_bracket_atomic', { p_league_id: league }))
          const final = await query(supabase.from('matchups').select('*').eq('league_season_id', season).eq('matchup_type', 'playoff_final').single())
          const finalDate = addDays(first, (final.week_number - 1) * 7 + 2)
          await query(supabase.from('nba_games').insert({ id: finalGame, nba_game_id: `002-final-${token}`, season_year: year,
            week_number: final.week_number, game_date: finalDate, game_time: `${finalDate}T19:00:00Z`, home_team: 'XCO', away_team: 'XCP', status: 'Final', stats_synced_at: new Date().toISOString() }))
          for (const [side, member] of [final.home_member_id, final.away_member_id].entries()) {
            const player = players[members.indexOf(member)]
            await query(supabase.from('player_game_stats').insert({ player_id: player, game_id: finalGame, season_year: year,
              week_number: final.week_number, game_date: finalDate, points: side ? 5 : 10, did_not_play: false }))
            await query(supabase.from('weekly_lineups').insert({ player_id: player, member_id: member, league_id: league,
              league_season_id: season, week_number: final.week_number, game_date: finalDate, slot_type: 'PG', is_auto_set: false }))
          }
          await syncScores(league)
          const readFinal = () => query(supabase.from('matchups').select('*').eq('id', final.id).single())
          const before = await readFinal()
          assert.equal(before.winner_member_id, final.home_member_id)
          const boundary = await runSeasonBoundary(new Date(Date.now() + 49 * 3600000), league)
          assert.ok(boundary[0]?.actions.includes('season-advanced'), JSON.stringify(boundary))
          await query(supabase.from('player_game_stats').update({ points: 20 }).eq('game_id', finalGame)
            .eq('player_id', players[members.indexOf(final.away_member_id)]))
          await syncScores(league)
          const after = await readFinal()
          const unchanged = JSON.stringify(after) === JSON.stringify(before)
          const report = { span, phase, unchanged, winnerChanged: before.winner_member_id !== after.winner_member_id,
            beforePoints: [before.home_points, before.away_points], afterPoints: [after.home_points, after.away_points], boundary }
          reports.push(report); console.log(JSON.stringify(report))
          if (!unchanged) failures.push(`span${span}: completed championship changed after rollover`)
        }
      } finally {
        intercept = undefined
        await query(supabase.from('leagues').delete().eq('id', league))
        await query(supabase.from('player_game_stats').delete().in('game_id', [game, finalGame]))
        await query(supabase.from('nba_games').delete().in('id', [game, finalGame]))
        await query(supabase.from('players').delete().in('id', players))
        if (weeksInserted) await query(supabase.from('season_weeks').delete().in('id', weekIds))
        for (const user of users) {
          const { error } = await supabase.auth.admin.deleteUser(user)
          if (error) throw new Error(error.message)
        }
        console.log(JSON.stringify({ span, phase, cleanup: 'complete' }))
      }
    }
  }
} finally {
  globalThis.fetch = nativeFetch
}
console.log(JSON.stringify({ scenarios: reports.length, failures }))
assert.deepEqual(failures, [])
