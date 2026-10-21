import { strict as assert } from 'node:assert'
import { fixture, q, sql, supabase, syncScores, syncStatsGame, finalizedWeeks, closeProvider } from './makeup-harness.ts'

async function recovery(mode: string) {
  const f = await fixture(2025, false, 'CHI', 'MIA')
  try {
    await f.matchup(12); await f.matchup(13)
    await f.game('2026-01-07', 'Final', 'Final', [10, 15, 5]); await f.lineup('2026-01-07')
    await f.game('2026-01-13', 'Final', 'Final', [7, 12, 4]); await f.lineup('2026-01-13')
    const unavailable = await f.game('2026-01-08', 'Final')
    unavailable.mode = mode; unavailable.confirm = 'PPD - provider confirmed Jan 8, makeup Jan 29'
    const failedGate = await supabase.rpc('generate_playoff_bracket_atomic', { p_league_id: f.league })
    assert.ok(failedGate.error, 'An incomplete regular week must block the playoff gate')
    let error: unknown
    try { await syncScores(f.league, new Date('2026-01-19T12:00:00Z')) } catch (failure) { error = failure }
    const rows = await f.read()
    console.log(JSON.stringify({ provenance: 'SYNTHETIC', mode, phase: 'confirmed-during-recovery', error: String(error),
      finalized: rows.map((row: any) => [row.week_number, row.is_finalized]), providerReads: unavailable.calls }))
    assert.equal(error, undefined, 'Confirmed unavailability must clear its recovery failure')
    assert.ok(rows.every((row: any) => row.is_finalized), 'An unavailable recovery failure must not defer later standings')
    assert.deepEqual(rows.map((row: any) => [row.home_points, row.away_points]), [[10, 5], [7, 4]])
    assert.equal((await q(supabase.from('standings').select('wins').eq('league_season_id', f.seasonId).eq('week_number', 13).eq('member_id', f.members[0]).single())).wins, 2)
    assert.deepEqual(await f.stale(), [])
    const generated = await q(supabase.rpc('generate_playoff_bracket_atomic', { p_league_id: f.league }))
    assert.equal(generated.inserted, 1)
  } finally { await f.close() }
}

async function controls() {
  for (const scenario of ['cancelled', 'confirmed-403', 'confirmed-404', 'confirmed-scheduled', 'live', 'unknown', '500', 'timeout']) {
    const f = await fixture()
    try {
      await f.matchup(12)
      if (scenario === 'unknown') {
        await f.matchup(13)
        await f.game('2026-01-13', 'Final', 'Final', [7, 12, 4]); await f.lineup('2026-01-13')
      }
      const confirmed = scenario.startsWith('confirmed') || scenario === 'cancelled'
      const entry = await f.game('2026-01-08', scenario === 'live' ? 'InProgress' : scenario === 'unknown' || confirmed ? 'Scheduled' : 'Final',
        confirmed ? scenario === 'cancelled' ? 'Cancelled - never played' : 'PPD - confirmed' : '')
      entry.mode = scenario === 'unknown' ? 'scheduled' : scenario.startsWith('confirmed') ? scenario.slice(10) : scenario
      if (confirmed) {
        await syncScores(f.league, new Date('2026-01-09T12:00:00Z'))
        assert.equal((await f.read())[0].is_finalized, false, 'An unavailable game must not close a week before its last day ends')
      }
      let error: unknown
      try { await syncScores(f.league, new Date(scenario === 'unknown' ? '2026-01-19T12:00:00Z' : '2026-01-12T12:00:00Z')) } catch (failure) { error = failure }
      const row = (await f.read())[0]
      assert.equal(row.is_finalized, confirmed, `Incorrect finalization for ${scenario}`)
      if (scenario === 'unknown') assert.ok((await f.read()).every((row: any) => !row.is_finalized), 'Missing prior standings must defer the next week')
      if (confirmed) {
        assert.equal(entry.calls, 0, 'Already unavailable games must never fetch boxes')
        assert.equal(error, undefined)
        assert.equal(await sql(`SELECT count(*) FROM private.score_week_certificates WHERE league_season_id='${f.seasonId}'`), '1')
      } else if (['500', 'timeout'].includes(scenario)) {
        assert.ok(error instanceof AggregateError, 'An available provider outage must be surfaced')
      }
      console.log(JSON.stringify({ scenario, isFinalized: row.is_finalized, providerReads: entry.calls, error: String(error) }))
    } finally { await f.close() }
  }
}

async function makeup(sameWeek: boolean) {
  const f = await fixture(2025, false, sameWeek ? 'MIN' : 'CHI', sameWeek ? 'GSW' : 'MIA')
  try {
    const original = sameWeek ? '2026-01-24' : '2026-01-08'
    const played = sameWeek ? '2026-01-25' : '2026-01-29'
    const week = f.weekFor(original), makeupWeek = f.weekFor(played)
    if (sameWeek) await q(supabase.from('leagues').update({ playoff_start_week: 23 }).eq('id', f.league))
    await f.matchup(week)
    const entry = await f.game(original, 'Scheduled', 'PPD - confirmed')
    await syncScores(f.league, new Date(sameWeek ? '2026-01-26T12:00:00Z' : '2026-01-12T12:00:00Z'))
    let originalToken = await f.capture(week)
    const reconciliationCount = () => finalizedWeeks.filter(row => row.season === f.seasonId && row.week === week).length
    assert.equal(reconciliationCount(), 1)
    assert.equal((await f.read())[0].is_finalized, true)
    assert.equal(Number((await f.read())[0].home_points), 0)
    if (!sameWeek) {
      await f.matchup(13)
      await f.game('2026-01-13', 'Final', 'Final', [7, 12, 4]); await f.lineup('2026-01-13')
      await syncScores(f.league, new Date('2026-01-19T12:00:00Z'))
      await q(supabase.rpc('generate_playoff_bracket_atomic', { p_league_id: f.league }))
      const final = (await f.read()).find((row: any) => row.matchup_type === 'playoff_final')
      assert.equal(final.week_number, 14); assert.equal(final.end_week_number, 15)
    }
    await q(supabase.from('nba_games').update({ game_date: played, week_number: makeupWeek, game_time: `${played}T23:00:00Z`,
      status: 'Scheduled', game_status_text: '7:00 PM ET' }).eq('id', entry.game))
    await f.lineup(played)
    if (!sameWeek) {
      const cancellation = await f.game('2026-01-30', 'Scheduled', 'Cancelled - never played')
      cancellation.mode = '404'
      assert.ok((await f.stale()).some((row: any) => row.week_number === week), 'Moving a game must invalidate its original certificate')
      const beforeMove = reconciliationCount()
      await syncScores(f.league, new Date('2026-01-26T12:00:00Z'), { recoverStats: false })
      assert.equal(reconciliationCount(), beforeMove + 1, 'The original week must reconcile exactly once after a move')
      assert.equal((await f.read()).find((row: any) => row.matchup_type === 'playoff_final').is_finalized, false)
      assert.deepEqual(await f.stale(), [])
      originalToken = await f.capture(week)
    }
    entry.mode = 'final'
    await syncStatsGame({ id: entry.game, nba_game_id: entry.provider, season_year: f.year, week_number: makeupWeek, status: 'Scheduled' })
    const expectedDate = sameWeek ? '2026-01-26T12:00:00Z' : '2026-02-02T12:00:00Z'
    await syncScores(f.league, new Date(expectedDate), { recoverStats: false })
    const scored = await f.read()
    const target = sameWeek ? scored[0] : scored.find((row: any) => row.matchup_type === 'playoff_final')
    assert.equal(target.is_finalized, true)
    assert.equal(Number(target.home_points), 20); assert.equal(Number(target.away_points), 5)
    assert.equal(Number(target.home_max_possible_points), 30)
    if (!sameWeek) {
      assert.equal(Number(scored[0].home_points), 0, 'Cross-week makeup must not count in its original week')
      assert.deepEqual(await f.capture(week), originalToken, 'A reschedule must reconcile its original certificate once before later imports')
    }
    const before = await f.capture(week)
    const beforeRedelivery = reconciliationCount()
    const stats = await q(supabase.from('player_game_stats').select('id,player_id,game_id,game_date,week_number,points').eq('game_id', entry.game).order('id'))
    assert.equal(stats.length, 3)
    assert.ok(stats.every((row: any) => row.game_date === played && row.week_number === makeupWeek))
    await syncStatsGame({ id: entry.game, nba_game_id: entry.provider, season_year: f.year, week_number: makeupWeek, status: 'Final' })
    assert.deepEqual(await q(supabase.from('player_game_stats').select('id,player_id,game_id,game_date,week_number,points').eq('game_id', entry.game).order('id')), stats, 'Redelivery must retain each player stat exactly once')
    assert.deepEqual(await f.capture(week), before, 'Identical final redelivery must not invalidate the certificate again')
    await syncScores(f.league, new Date(expectedDate), { recoverStats: false })
    assert.deepEqual(await f.stale(), [])
    const repeated = (await f.read()).find((row: any) => row.id === target.id)
    assert.equal(Number(repeated.home_points), 20)
    assert.equal(repeated.finalized_at, target.finalized_at)
    if (!sameWeek) assert.equal(reconciliationCount(), beforeRedelivery, 'Later imports must not reconcile the original week twice')
    console.log(JSON.stringify({ scenario: sameWeek ? 'GSW-MIN Jan24-Jan25' : 'MIA-CHI Jan8-Jan29', originalWeek: week, playedWeek: makeupWeek,
      originalPoints: Number((await f.read())[0].home_points), actualPoints: Number(repeated.home_points), maxPoints: Number(repeated.home_max_possible_points), stats: stats.length }))
  } finally { await f.close() }
}

try {
  const mode = Deno.args[0] ?? 'all'
  if (['403', '404', 'scheduled'].includes(mode)) await recovery(mode)
  else if (mode === 'controls') await controls()
  else if (mode === 'same') await makeup(true)
  else if (mode === 'cross') await makeup(false)
  else { for (const mode of ['403', '404', 'scheduled']) await recovery(mode); await controls(); await makeup(true); await makeup(false) }
} finally { await closeProvider() }

Deno.exit(0)
