import { strict as assert } from 'node:assert'

// Every successful database response comes from the actual local server.
// The interceptor only delays a completed read. It never changes response bytes.
async function runRegression(scenario: 'regular-overlap' | 'regular-history' | 'playoff-overlap' | 'consumed-playoff') {
  const historical = scenario === 'regular-history' || scenario === 'consumed-playoff'
  const playoff = scenario === 'playoff-overlap' || scenario === 'consumed-playoff'
  const consumed = scenario === 'consumed-playoff'
  const weekNumber = playoff ? 3 : 1
  let repeatedReplayCalls: unknown[] = []
  const api = Deno.env.get('SUPABASE_URL')
  assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname), 'Only an isolated local database is allowed')
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const token = crypto.randomUUID().replaceAll('-', '')
  const uuid = () => crypto.randomUUID()
  const league = uuid(), season = uuid(), nextSeason = uuid()
  const members = [uuid(), uuid()], players = [uuid(), uuid()], games = [uuid(), uuid()]
  const createdUsers: string[] = []
  const allocatedWeekIds: string[] = []
  let armed = false
  let pausedReads = 0
  let barrier: (() => Promise<void>) | undefined
  const requestLog: Array<{ table: string; method: string }> = []
  let start = ''
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.origin, api, 'The reproduction must not contact external services')
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const table = url.pathname.split('/').at(-1) ?? ''
    requestLog.push({ table, method })
    const response = await nativeFetch(input, init)
    if (armed && method === 'GET' && table === 'player_game_stats'
      && url.searchParams.get('select')?.includes('points,rebounds,assists')
      && url.searchParams.get('player_id')?.includes(players[0])
      && url.searchParams.get('game_date') === `gte.${oldWeek.week_start}`) {
      armed = false
      assert.equal(response.ok, true, 'The paused stat query must succeed against the database')
      const rows = await response.clone().json()
      assert.equal(rows.find((row: any) => row.player_id === players[0])?.points, 30,
        'The actual captured database read must contain the pre-correction points')
      pausedReads++
      await barrier!()
    }
    return response
  }
  const { supabase } = await import('../../functions/_shared/supabase.ts')
  const { syncScores } = await import('../../functions/_shared/syncScores.ts')
  const { calcWeekPointsByMember } = await import('../../functions/_shared/scoreLineups.ts')
  const query = async (q: any): Promise<any> => {
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const addDays = (day: string, count: number) =>
    new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10)
  const currentStart = addDays(today, -28)
  start = historical ? addDays(currentStart, -364) : currentStart
  let year = 0
  let oldWeek: any
  let report: any
  try {
    // Allocate unused years. Record exact inserted row IDs for cleanup.
    for (let attempt = 0; attempt < 50; attempt++) {
      const trial = 3000 + crypto.getRandomValues(new Uint32Array(1))[0] % 5000
      const used = await query(supabase.from('season_weeks').select('id').in('season_year', [trial, trial + 1]))
      const seasons = await query(supabase.from('league_seasons').select('id').in('season_year', [trial, trial + 1]))
      const gameRows = await query(supabase.from('nba_games').select('id').in('season_year', [trial, trial + 1]))
      if (!used.length && !seasons.length && !gameRows.length) { year = trial; break }
    }
    assert.ok(year, 'No unused synthetic year is available')
    for (let side = 0; side < 2; side++) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `score-${token}-${side}@example.test`,
        password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
        user_metadata: { username: `score_${token.slice(0, 15)}_${side}`, display_name: 'Synthetic score review' },
      })
      if (error) throw new Error(error.message)
      assert.ok(data.user)
      createdUsers.push(data.user.id)
    }
    await query(supabase.from('leagues').insert({
      id: league, name: 'Synthetic scoring correction review', slug: `score-${token}`,
      commissioner_id: createdUsers[0], status: 'active', scoring_settings: { points: 1 },
    }))
    await query(supabase.from('league_members').insert(members.map((id, side) => ({
      id, league_id: league, user_id: createdUsers[side], role: side ? 'manager' as const : 'commissioner' as const,
      team_name: `Synthetic side ${side}`,
    }))))
    await query(supabase.from('league_seasons').insert({
      id: season, league_id: league, season_year: year, is_current: true,
    }))
    const insertWeeks = async (seasonYear: number, first: string) => {
      const rows = Array.from({ length: 5 }, (_, index) => ({
        id: uuid(), season_year: seasonYear, week_number: index + 1,
        week_start: addDays(first, index * 7), week_end: addDays(first, index * 7 + 6),
      }))
      await query(supabase.from('season_weeks').insert(rows))
      allocatedWeekIds.push(...rows.map((row) => row.id))
      return rows
    }
    const weeks = await insertWeeks(year, start)
    oldWeek = weeks[weekNumber - 1]
    await query(supabase.from('players').insert(players.map((id, side) => ({
      id, first_name: 'Synthetic', last_name: `Score ${token}-${side}`, position: 'PG' as const,
      eligible_positions: ['PG'], nba_team: side ? 'XSA' : 'XSH',
    }))))
    await query(supabase.from('roster_players').insert(players.map((player, side) => ({
      id: uuid(), player_id: player, league_id: league, league_season_id: season,
      member_id: members[side], acquired_via: 'draft', acquired_at: `${addDays(start, -7)}T12:00:00Z`,
      is_on_ir: false, is_on_taxi: false,
    }))))
    const gameDate = addDays(oldWeek.week_start, 2)
    await query(supabase.from('nba_games').insert(games.map((id, side) => ({
      id, nba_game_id: `002-score-${token}-${side}`, season_year: year,
      week_number: weekNumber, game_date: gameDate, game_time: `${gameDate}T19:00:00Z`,
      home_team: side ? 'XSA' : 'XSH', away_team: 'XSO', status: 'Final',
    }))))
    await query(supabase.from('player_game_stats').insert(players.map((player, side) => ({
      player_id: player, game_id: games[side], season_year: year, week_number: weekNumber,
      game_date: gameDate, points: side ? 20 : 30, did_not_play: false,
    }))))
    // These fixtures provide completed box-score rows directly.
    await query(supabase.from('nba_games').update({ stats_synced_at: new Date().toISOString() }).in('id', games))
    // Keep the lineup fixture independent of automatic roster-link maintenance.
    await query(supabase.from('weekly_lineups').delete().eq('league_id', league))
    await query(supabase.from('weekly_lineups').insert(players.map((player, side) => ({
      id: uuid(), player_id: player, member_id: members[side], league_id: league,
      league_season_id: season, week_number: weekNumber, game_date: gameDate, slot_type: 'PG' as const, is_auto_set: false,
    }))))
    await query(supabase.from('matchups').insert(weeks.filter((week) => !playoff || week.week_number <= 3).map((week) => ({
      id: uuid(), league_id: league, league_season_id: season, week_number: week.week_number,
      home_member_id: members[0], away_member_id: members[1], matchup_type: !playoff || week.week_number < 3 ? 'regular_season' as const : week.week_number === 3 ? 'playoff_quarterfinal' as const : week.week_number === 4 ? 'playoff_semifinal' as const : 'playoff_final' as const, is_finalized: false,
    }))))
    const reference = new Date(`${addDays(start, 28)}T16:00:00Z`)
    const readState = async () => ({
      matchup: await query(supabase.from('matchups').select('home_points,away_points,winner_member_id,is_finalized,finalized_at,score_read_started_at,home_max_possible_points,away_max_possible_points')
        .eq('league_season_id', season).eq('week_number', weekNumber).single()),
      standing: await query(supabase.from('standings').select('wins,losses,ties,points_for,points_against,created_at')
        .eq('league_season_id', season).eq('member_id', members[0]).eq('week_number', playoff ? 2 : 1).single()),
    })
    const assertRegularWeekClosure = async (lastClosedWeek: number) => {
      const matchups = await query(supabase.from('matchups').select('week_number,is_finalized,finalized_at')
        .eq('league_season_id', season).eq('matchup_type', 'regular_season'))
      const snapshots = await query(supabase.from('standings').select('member_id,week_number')
        .eq('league_season_id', season))
      assert.equal(matchups.length, weeks.length)
      assert.equal(snapshots.length, lastClosedWeek * members.length, 'Only closed regular weeks have standings')
      for (const week of weeks) {
        const matchup = matchups.find((row: any) => row.week_number === week.week_number)
        assert.ok(matchup, `Week ${week.week_number} must retain its matchup`)
        const closed = week.week_number <= lastClosedWeek
        assert.equal(matchup.is_finalized, closed, `Week ${week.week_number} finalization follows its stored end`)
        assert.equal(matchup.finalized_at == null, !closed, `Week ${week.week_number} finalization timestamp follows closure`)
        assert.deepEqual(snapshots.filter((row: any) => row.week_number === week.week_number)
          .map((row: any) => row.member_id).sort(), closed ? [...members].sort() : [],
        `Week ${week.week_number} standings include every member only after closure`)
      }
      console.log(JSON.stringify({ scenario, closedRegularWeeks: lastClosedWeek, standingSnapshots: snapshots.length }))
    }
    await syncScores(league, reference)
    const before = await readState()
    assert.equal(Number(before.matchup.home_points), 30, 'Control must score the original game')
    assert.equal(Number(before.matchup.away_points), 20, 'Control must score the opponent')
    assert.equal(before.matchup.winner_member_id, members[0])
    assert.equal(before.standing.wins, playoff ? 0 : 1)
    const snapshots = await query(supabase.from('standings').select('member_id,week_number').eq('league_season_id', season))
    if (playoff) assert.equal(snapshots.length, 4, 'Only regular-season weeks have standings')
    else await assertRegularWeekClosure(4)
    if (playoff) {
      await syncScores(league, reference)
      const unchanged = await readState()
      assert.equal(unchanged.matchup.finalized_at, before.matchup.finalized_at, 'Unchanged replay preserves playoff grace')
      assert.ok(Date.parse(unchanged.matchup.score_read_started_at) >= Date.parse(before.matchup.score_read_started_at))
    }
    if (consumed) {
      // This historical fixture adds each consumer only after its prior result
      // finalizes. Creating all rounds up front would freeze an unscored result.
      for (const week of weeks.filter((row) => row.week_number > 3)) {
        await query(supabase.from('matchups').insert({
          id: uuid(), league_id: league, league_season_id: season, week_number: week.week_number,
          home_member_id: members[0], away_member_id: members[1],
          matchup_type: week.week_number === 4 ? 'playoff_semifinal' : 'playoff_final', is_finalized: false,
        }))
        await syncScores(league, reference)
      }
    }
    const move = async (targetYear: number, targetDate: string, targetWeek: number) => {
      await query(supabase.from('nba_games').update({ season_year: targetYear, game_date: targetDate,
        game_time: `${targetDate}T19:00:00Z`, week_number: targetWeek }).eq('id', games[0]))
      const stat = await query(supabase.from('player_game_stats').select('season_year,game_date,week_number,points,updated_at')
        .eq('game_id', games[0]).single())
      assert.equal(stat.season_year, targetYear)
      assert.equal(stat.game_date, targetDate)
      assert.equal(stat.week_number, targetWeek)
      const ledger = await query(supabase.from('game_calendar_corrections').select('season_year,game_date,updated_at')
        .eq('game_id', games[0]))
      assert.ok(ledger.some((row: any) => row.season_year === year && row.game_date === gameDate),
        'The real calendar trigger must retain the old scoring date')
      assert.ok(ledger.some((row: any) => row.season_year === targetYear && row.game_date === targetDate),
        'The real calendar trigger must retain the new scoring date')
      return { stat, ledger }
    }
    let correction: any
    let firstReplay: any
    if (!historical) {
      const inputBefore = await query(supabase.rpc('capture_score_inputs', {
        p_league_season_id: season, p_week_number: weekNumber,
      }))
      // Rebounds are a real tracked input, but this league only awards points.
      await query(supabase.from('player_game_stats').update({ rebounds: 1 }).eq('game_id', games[0]))
      const inputAfter = await query(supabase.rpc('capture_score_inputs', {
        p_league_season_id: season, p_week_number: weekNumber,
      }))
      assert.notDeepEqual(inputAfter, inputBefore, 'A real input change must invalidate the week certificate')
      const staleWeeks = await query(supabase.rpc('get_stale_score_weeks', {
        p_league_season_id: season, p_through_week: weekNumber,
      }))
      assert.ok(staleWeeks.some((week: { week_number: number }) => week.week_number === weekNumber),
        'The first scoring pass must select week one through an actual input revision')
      barrier = async () => {
        correction = await move(year, addDays(gameDate, 7), weekNumber + 1)
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      armed = true
      await syncScores(league) // Current date is in fixture week five.
      assert.equal(pausedReads, 1, 'The actual old-week score read must hit the barrier once')
      firstReplay = await readState()
      await syncScores(league)
    } else {
      await query(supabase.from('league_seasons').update({ is_current: false }).eq('id', season))
      await query(supabase.from('league_seasons').insert({
        id: nextSeason, league_id: league, season_year: year + 1, is_current: true,
      }))
      await insertWeeks(year + 1, currentStart)
      correction = await move(year + 1, addDays(currentStart, 2), 1)
      const marker = requestLog.length
      await syncScores(league)
      const replayMarker = requestLog.length
      await syncScores(league)
      repeatedReplayCalls = requestLog.slice(replayMarker).filter((r) =>
        (r.table === 'matchups' && r.method !== 'GET') || r.table === 'update_score_points_atomic' || r.table === 'finalize_score_week_atomic')
      firstReplay = { scoreWrites: requestLog.slice(marker).filter((r) =>
        (r.table === 'matchups' && r.method !== 'GET') || r.table === 'update_score_points_atomic' || r.table === 'finalize_score_week_atomic') }
    }
    const fresh = await calcWeekPointsByMember(members, season, year, weekNumber, { points: 1 },
      oldWeek.week_start, oldWeek.week_end)
    assert.equal(fresh.get(members[0]), 0, 'A new real lineup calculation must remove the moved game')
    assert.equal(fresh.get(members[1]), 20)
    const after = await readState()
    report = { scenario, before, correction, pausedReads, firstReplay, after,
      freshHomePoints: fresh.get(members[0]), freshAwayPoints: fresh.get(members[1]), repeatedReplayCalls }
    console.log(JSON.stringify(report))
    if (consumed) {
      assert.equal(Number(after.matchup.home_points), 30, 'Consumed quarterfinal points stay frozen')
      assert.equal(after.matchup.winner_member_id, before.matchup.winner_member_id)
      assert.equal(after.matchup.finalized_at, before.matchup.finalized_at)
      assert.equal(repeatedReplayCalls.length, 0, 'Consumed-only correction does not replay historical rounds')
    } else {
      assert.equal(Number(after.matchup.home_points), 0, 'Automatic scoring repairs the corrected old week')
      assert.equal(after.matchup.winner_member_id, members[1], 'Winner follows corrected points')
      if (!playoff) {
        assert.equal(after.standing.wins, 0)
        assert.equal(after.standing.losses, 1)
        assert.equal(Number(after.standing.points_for), 0)
        assert.equal(Number(after.standing.points_against), 20)
      }
    }
    if (!playoff) {
      if (!historical) {
        await assertRegularWeekClosure(4)
        await syncScores(league, new Date(`${addDays(weeks[4].week_end, 1)}T16:00:00Z`))
      }
      await assertRegularWeekClosure(5)
    }

  } finally {
    armed = false
    const errors: string[] = []
    const clean = async (label: string, action: () => Promise<any>) => {
      try { await action() } catch (error) { errors.push(`${label}: ${(error as Error).message}`) }
    }
    // All predicates target only newly created synthetic identities.
    await clean('league', () => query(supabase.from('leagues').delete().eq('id', league)))
    await clean('stats', () => query(supabase.from('player_game_stats').delete().in('game_id', games)))
    await clean('games', () => query(supabase.from('nba_games').delete().in('id', games)))
    await clean('players', () => query(supabase.from('players').delete().in('id', players)))
    if (allocatedWeekIds.length) await clean('week rows', () =>
      query(supabase.from('season_weeks').delete().in('id', allocatedWeekIds)))
    for (const user of createdUsers) await clean('synthetic user', async () => {
      const { error } = await supabase.auth.admin.deleteUser(user)
      if (error) throw new Error(error.message)
    })
    globalThis.fetch = nativeFetch
    if (errors.length) throw new Error(`Synthetic fixture cleanup failed: ${errors.join('; ')}`)
    console.log(JSON.stringify({ scenario, cleanup: 'complete', result: report ? 'assertions reached' : 'setup or control failed' }))
  }
}

for (const scenario of ['regular-overlap', 'regular-history', 'playoff-overlap', 'consumed-playoff'] as const) {
  await runRegression(scenario)
}
