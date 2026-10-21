import { strict as assert } from 'node:assert'
import { fixture, day, q, sql, supabase, syncScores, closeProvider } from './makeup-harness.ts'

async function mergedSeason(season: number, skipped: boolean) {
  const f = await fixture(season, true)
  let channel: any
  try {
    const merged = f.weeks.find(week => week.week_number === 17)!
    const next = f.weeks.find(week => week.week_number === 18)!
    assert.equal(merged.week_end, day(merged.week_start, 13))
    assert.equal(next.week_start, day(merged.week_end, 1))
    let skippedMatch: string | undefined
    if (skipped) {
      skippedMatch = await f.matchup(1)
      await f.game(f.weeks[0].week_start, 'Final', 'Final', [1000, 2000, 500])
      await f.lineup(f.weeks[0].week_start)
      const signedIn = await f.userClient.auth.signInWithPassword({ email: `makeup-${f.members[0]}@example.test`, password: f.password })
      if (signedIn.error) throw signedIn.error
      await q(f.userClient.rpc('update_league_settings_atomic', { p_league_id: f.league, p_settings: { skipped_weeks: [1] } }))
    }
    const matchupId = await f.matchup(17)
    const events: any[] = []
    const streamStates: string[] = []
    if (!skipped) {
      const signedIn = await f.userClient.auth.signInWithPassword({ email: `makeup-${f.members[0]}@example.test`, password: f.password })
      if (signedIn.error) throw signedIn.error
    }
    channel = f.userClient.channel(`merged-${f.league}`).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matchups', filter: `id=eq.${matchupId}` }, (payload: any) => events.push(payload.new))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Merged-week subscription did not start')), 10000)
      channel.subscribe((status: string) => { streamStates.push(status); if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve() } })
    })
    const first = await f.game(merged.week_start, 'InProgress', 'Q4', [1, 2, 3])
    await f.lineup(merged.week_start)
    const firstWork = await q(supabase.rpc('get_live_poll_work', { p_now: `${merged.week_start}T23:20:00Z` }))
    assert.ok(firstWork.some((row: any) => row.id === first.game && row.week_number === 17 && row.needs_stats))
    await syncScores(f.league, new Date(`${merged.week_start}T23:30:00Z`), { recoverStats: false })
    await q(supabase.from('nba_games').update({ status: 'Final', stats_synced_at: new Date().toISOString() }).eq('id', first.game))
    await syncScores(f.league, new Date(`${day(merged.week_start, 6)}T23:00:00Z`), { recoverStats: false })
    assert.equal((await f.read()).find((row: any) => row.id === matchupId).is_finalized, false, 'Merged week must not finalize after the first NBA week')
    const entries = [first]
    for (let index = 1; index < 14; index++) {
      const date = day(merged.week_start, index)
      const entry = await f.game(date, 'InProgress', 'Q4', [1, 2, 3])
      entries.push(entry)
      await f.lineup(date)
      const work = await q(supabase.rpc('get_live_poll_work', { p_now: `${date}T23:20:00Z` }))
      assert.ok(work.some((row: any) => row.id === entry.game && row.week_number === 17 && row.needs_scoreboard && row.needs_stats), `Merged day ${index + 1} must remain live`)
      await syncScores(f.league, new Date(`${date}T23:30:00Z`), { recoverStats: false })
      const live = (await f.read()).find((row: any) => row.id === matchupId)
      assert.equal(Number(live.home_points), index + 1)
      assert.equal(Number(live.away_points), (index + 1) * 3)
      assert.equal(live.is_finalized, false)
    }
    const available = await q(supabase.rpc('get_score_sync_games', { p_start_date: merged.week_start, p_end_date: merged.week_end, p_season_year: f.year }))
    assert.equal(available.length, 14)
    await q(supabase.from('nba_games').update({ status: 'Final', stats_synced_at: new Date().toISOString() }).in('id', entries.map(entry => entry.game)))
    await syncScores(f.league, new Date(`${merged.week_end}T23:59:00Z`), { recoverStats: false })
    assert.equal((await f.read()).find((row: any) => row.id === matchupId).is_finalized, false, 'The last ET day must end before finalization')
    await syncScores(f.league, new Date(`${day(merged.week_end, 1)}T12:00:00Z`), { recoverStats: false })
    const final = (await f.read()).find((row: any) => row.id === matchupId)
    assert.equal(final.is_finalized, true)
    assert.equal(Number(final.home_points), 14); assert.equal(Number(final.away_points), 42)
    assert.equal(Number(final.home_max_possible_points), 28); assert.equal(Number(final.away_max_possible_points), 42)
    assert.deepEqual(await f.stale(), [])
    const before = await f.capture(17)
    assert.ok(`nba:${f.year}:17` in before)
    await f.matchup(18)
    await f.game(next.week_end, 'Final', 'Final', [9, 10, 4]); await f.lineup(next.week_end)
    await syncScores(f.league, new Date(`${day(next.week_end, 1)}T12:00:00Z`), { recoverStats: false })
    const after = (await f.read()).find((row: any) => row.week_number === 18)
    assert.equal(after.is_finalized, true)
    assert.equal(Number(after.home_points), 9)
    const standing = await q(supabase.from('standings').select('points_for,points_against,max_possible_points').eq('league_season_id', f.seasonId).eq('week_number', 18).eq('member_id', f.members[0]).single())
    assert.deepEqual([Number(standing.points_for), Number(standing.points_against), Number(standing.max_possible_points)], [23, 46, 38])
    assert.deepEqual(await f.stale(), [])
    if (skipped) {
      const row = (await f.read()).find((row: any) => row.id === skippedMatch)
      assert.equal(row.is_voided, true); assert.equal(row.is_finalized, false); assert.equal(Number(row.home_points), 0)
      assert.equal(await sql(`SELECT count(*) FROM private.score_week_certificates WHERE league_season_id='${f.seasonId}' AND week_number=1`), '0')
    }
    for (let attempts = 0; attempts < 600 && !events.some(row => Number(row.home_points) === 14); attempts++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(events.some(row => Number(row.home_points) === 14), `The actual matchup stream must deliver second-half points: ${JSON.stringify({ streamStates, events })}`)
    console.log(JSON.stringify({ provenance: 'SYNTHETIC', season, skipped, merged, next, days: 14, actual: [14, 42], maximum: [28, 42], nextStanding: standing, realtimeEvents: events.length }))
  } finally {
    if (channel) await f.userClient.removeChannel(channel)
    await f.close()
  }
}

try {
  if (['red', 'single'].includes(Deno.args[0])) await mergedSeason(2025, false)
  else for (const season of [2024, 2025]) for (const skipped of [false, true]) await mergedSeason(season, skipped)
} finally { await closeProvider() }
