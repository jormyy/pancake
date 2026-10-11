import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
assert.ok(api && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname), 'Only an isolated local backend is allowed')
const token = crypto.randomUUID().replaceAll('-', '')
let pendingProviderReads = 0
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
  assert.equal(new URL(request.url).pathname, `/liveData/boxscore/boxscore_002-span-${token}-1.json`)
  pendingProviderReads++
  return Response.json({ game: { gameStatus: 1, homeTeam: { players: [] }, awayTeam: { players: [] } } })
})
const providerOrigin = `http://127.0.0.1:${provider.addr.port}`
const priorProvider = Deno.env.get('NBA_CDN_BASE_URL')
Deno.env.set('NBA_CDN_BASE_URL', providerOrigin)
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.ok([api, providerOrigin].includes(url.origin), 'No external services may be contacted')
  return nativeFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
const query = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const league = crypto.randomUUID(), season = crypto.randomUUID()
const members = Array.from({ length: 4 }, () => crypto.randomUUID())
const players = Array.from({ length: 8 }, () => crypto.randomUUID())
const games = Array.from({ length: 5 }, () => crypto.randomUUID())
const weekIds = Array.from({ length: 8 }, () => crypto.randomUUID())
const users: string[] = []
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10)
const first = addDays(today, -70)
const dateForWeek = (week: number) => addDays(first, (week - 1) * 7 + 2)
let year = 0
let insertedWeeks = false
let reachedAssertions = false
const checks: string[] = []
const check = (ok: boolean, label: string) => { assert.ok(ok, label); checks.push(label) }
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = 3000 + crypto.getRandomValues(new Uint32Array(1))[0] % 5000
    const rows = await query(supabase.from('season_weeks').select('id').in('season_year', [candidate, candidate + 1]))
    const seasons = await query(supabase.from('league_seasons').select('id').in('season_year', [candidate, candidate + 1]))
    const existingGames = await query(supabase.from('nba_games').select('id').in('season_year', [candidate, candidate + 1]))
    if (!rows.length && !seasons.length && !existingGames.length) { year = candidate; break }
  }
  assert.ok(year)
  for (let side = 0; side < 4; side++) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `playoff-span-${token}-${side}@example.test`, password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
      user_metadata: { username: `span_${token.slice(0, 15)}_${side}`, display_name: 'Synthetic playoff span' },
    })
    if (error) throw new Error(error.message)
    assert.ok(data.user); users.push(data.user.id)
  }
  await query(supabase.from('leagues').insert({ id: league, slug: `span-${token}`, name: 'Synthetic multi-week playoffs',
    commissioner_id: users[0], status: 'active', scoring_settings: { points: 1, assists: 0.1 },
    playoff_start_week: 1, playoff_total_weeks: 5, playoff_round_weeks: [2, 3] }))
  await query(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league,
    user_id: users[side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Span side ${side}` }))))
  await query(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  await query(supabase.from('season_weeks').insert(weekIds.map((id, index) => ({ id, season_year: year, week_number: index + 1,
    week_start: addDays(first, index * 7), week_end: addDays(first, index * 7 + 6) }))))
  insertedWeeks = true
  await query(supabase.from('players').insert(players.map((id, index) => ({ id, first_name: 'Synthetic',
    last_name: `Span ${token}-${index}`, position: 'PG' as const, eligible_positions: ['PG'], nba_team: 'XSP', years_exp: 2 }))))
  await query(supabase.from('roster_players').insert(players.map((id, index) => ({ player_id: id,
    member_id: members[Math.floor(index / 2)], league_id: league, league_season_id: season,
    acquired_via: 'draft', acquired_at: `${addDays(first, -7)}T12:00:00Z` }))))
  await query(supabase.from('nba_games').insert(games.map((id, index) => ({ id, nba_game_id: `002-span-${token}-${index}`,
    season_year: year, week_number: index + 1, game_date: dateForWeek(index + 1), game_time: `${dateForWeek(index + 1)}T19:00:00Z`,
    home_team: 'XSP', away_team: 'XSQ', status: 'Final', stats_synced_at: new Date().toISOString() }))))
  await query(supabase.from('weekly_lineups').delete().eq('league_id', league))
  // Actual boundary code handles start1 instead of repeatedly creating an empty schedule.
  const started = await runSeasonBoundary(new Date(), league)
  check(started[0]?.actions.includes('bracket-generated') === true, 'start1 boundary generates a real bracket')
  const semis = await query(supabase.from('matchups').select('*').eq('league_season_id', season).eq('matchup_type', 'playoff_semifinal').order('id'))
  check(semis.length === 2 && semis.every((row: any) => row.week_number === 1 && row.end_week_number === 2), 'semifinals span weeks1and2')
  const homeMembers = new Set(semis.map((row: any) => row.home_member_id))
  const rows = []
  const lineupRows = []
  for (let week = 1; week <= 2; week++) {
    for (let index = 0; index < players.length; index++) {
      const member = members[Math.floor(index / 2)]
      const home = homeMembers.has(member)
      const bench = index % 2 === 1
      const points = bench ? (home ? 25 : 0) : home ? (week === 1 ? 10 : 30) : (week === 1 ? 20 : 10)
      rows.push({ player_id: players[index], game_id: games[week - 1], season_year: year, week_number: week,
        game_date: dateForWeek(week), points, did_not_play: false })
      lineupRows.push({ player_id: players[index], member_id: member, league_id: league, league_season_id: season,
        week_number: week, game_date: dateForWeek(week), slot_type: bench ? 'BE' as const : 'PG' as const, is_auto_set: false })
    }
  }
  await query(supabase.from('player_game_stats').insert(rows))
  await query(supabase.from('weekly_lineups').insert(lineupRows))
  const readSemis = () => query(supabase.from('matchups').select('*').eq('league_season_id', season).eq('matchup_type', 'playoff_semifinal').order('id'))
  // Reference-date injection exercises the real scorer against historical fixtures.
  // It is a simulated clock boundary, not a claim that two calendar weeks elapsed.
  await syncScores(league, new Date(`${addDays(first, 7)}T16:00:00Z`))
  let scored = await readSemis()
  check(scored.every((row: any) => Number(row.home_points) === 40 && Number(row.away_points) === 30), 'actual starter points aggregate both lineup weeks')
  check(scored.every((row: any) => !row.is_finalized && row.winner_member_id == null), 'no early decision before round end despite all fixture games final')
  await query(supabase.from('nba_games').update({ status: 'Scheduled' }).eq('id', games[1]))
  await syncScores(league)
  check((await readSemis()).every((row: any) => !row.is_finalized), 'pending game in final covered week blocks decision')
  check(pendingProviderReads > 0, 'pending game uses an explicit synthetic upstream response over local HTTP')
  await query(supabase.from('nba_games').update({ status: 'Final' }).eq('id', games[1]))
  await syncScores(league)
  scored = await readSemis()
  check(scored.every((row: any) => row.is_finalized && row.winner_member_id === row.home_member_id), 'aggregate winner differs from first-week leader')
  for (const matchup of semis) {
    const awayIndex = members.indexOf(matchup.away_member_id)
    await query(supabase.from('player_game_stats').update({ points: 20 }).eq('game_id', games[1]).eq('player_id', players[awayIndex * 2]))
  }
  await syncScores(league)
  scored = await readSemis()
  check(scored.every((row: any) => Number(row.home_points) === 40 && Number(row.away_points) === 40 &&
    Number(row.home_max_possible_points) > Number(row.away_max_possible_points) && row.winner_member_id === row.home_member_id), 'tied aggregate uses max possible points across the full round')
  await query(supabase.from('player_game_stats').update({ points: 0 }).in('game_id', games.slice(0, 2)).in('player_id', players.filter((_, index) => index % 2 === 1)))
  await syncScores(league)
  scored = await readSemis()
  check(scored.every((row: any) => Number(row.home_max_possible_points) === Number(row.away_max_possible_points) &&
    row.winner_member_id === row.home_member_id), 'exact aggregate and max tie retains seeded home winner')
  const grace = scored.map((row: any) => row.finalized_at)
  await syncScores(league)
  check((await readSemis()).every((row: any, index: number) => row.finalized_at === grace[index]), 'unchanged multi-week replay preserves grace')
  const boundaryBefore = await runSeasonBoundary(new Date(), league)
  check(!boundaryBefore[0]?.actions.includes('final-created'), 'automatic progression waits for correction grace')
  // Reference clock moves beyond grace; no stored timestamp is forged.
  const afterGrace = new Date(Date.now() + 49 * 3600000)
  const advanced = await runSeasonBoundary(afterGrace, league)
  check(advanced[0]?.actions.includes('final-created') === true, 'actual boundary advances after grace')
  const final = await query(supabase.from('matchups').select('*').eq('league_season_id', season).eq('matchup_type', 'playoff_final').single())
  check(final.week_number === 3 && final.end_week_number === 5, 'final uses remaining three weeks')
  const frozen = await readSemis()
  await query(supabase.from('player_game_stats').update({ points: 1000 }).eq('game_id', games[1]).eq('player_id', players[0]))
  for (let week = 3; week <= 5; week++) {
    for (const [side, member] of [final.home_member_id, final.away_member_id].entries()) {
      const player = players[members.indexOf(member) * 2]
      await query(supabase.from('player_game_stats').insert({ player_id: player, game_id: games[week - 1], season_year: year,
        week_number: week, game_date: dateForWeek(week), points: side ? 4 : 5, did_not_play: false }))
      await query(supabase.from('weekly_lineups').insert({ player_id: player, member_id: member, league_id: league, league_season_id: season,
        week_number: week, game_date: dateForWeek(week), slot_type: 'PG', is_auto_set: false }))
    }
  }
  await syncScores(league)
  const finalScored = await query(supabase.from('matchups').select('*').eq('id', final.id).single())
  check(Number(finalScored.home_points) === 15 && Number(finalScored.away_points) === 12 && finalScored.winner_member_id === final.home_member_id, 'three-week final aggregates all starter scores and chooses champion')
  for (const [side, member] of [final.home_member_id, final.away_member_id].entries()) {
    const player = players[members.indexOf(member) * 2]
    const assists = side ? [1, 2, 0] : [0, 0, 3]
    for (let index = 0; index < 3; index++) {
      await query(supabase.from('player_game_stats').update({ points: 0, assists: assists[index] })
        .eq('player_id', player).eq('game_id', games[index + 2]))
    }
  }
  await syncScores(league)
  const decimalTie = await query(supabase.from('matchups').select('*').eq('id', final.id).single())
  console.log(JSON.stringify({ decimalTie: { home: decimalTie.home_points, away: decimalTie.away_points,
    homeMax: decimalTie.home_max_possible_points, awayMax: decimalTie.away_max_possible_points,
    winnerIsSeededHome: decimalTie.winner_member_id === decimalTie.home_member_id } }))
  check(Number(decimalTie.home_points) === 0.3 && Number(decimalTie.away_points) === 0.3 &&
    decimalTie.winner_member_id === decimalTie.home_member_id, 'equal decimal totals use existing seeded-home tie rule')
  check(JSON.stringify(await readSemis()) === JSON.stringify(frozen), 'consumed multi-week semifinals remain frozen after a later correction')
  const standings = await query(supabase.from('standings').select('id').eq('league_season_id', season))
  check(standings.length === 0, 'playoff-only season never inflates regular standings')
  const rollover = await runSeasonBoundary(new Date(Date.now() + 49 * 3600000), league)
  check(rollover[0]?.actions.includes('season-advanced') === true, 'automatic rollover follows final decision and grace')
  const seasons = await query(supabase.from('league_seasons').select('id,season_year,is_current').eq('league_id', league).order('season_year'))
  check(seasons.length === 2 && seasons[0].id === season && seasons[0].is_current === false && seasons[1].is_current === true &&
    seasons[1].season_year === year + 1, 'rollover retains completed season and creates exactly one next season')
  reachedAssertions = true
  console.log(JSON.stringify({ scenario: 'real-multiweek-score-boundary', checks: checks.length, passed: checks, clockLimit: 'referenceDate injects early/after-grace times; real elapsed weeks are not claimed' }))
} finally {
  const errors: string[] = []
  const clean = async (label: string, action: () => Promise<any>) => {
    try { await action() } catch (error) { errors.push(`${label}: ${(error as Error).message}`) }
  }
  await clean('league', () => query(supabase.from('leagues').delete().eq('id', league)))
  await clean('stats', () => query(supabase.from('player_game_stats').delete().in('game_id', games)))
  await clean('games', () => query(supabase.from('nba_games').delete().in('id', games)))
  await clean('players', () => query(supabase.from('players').delete().in('id', players)))
  if (insertedWeeks) await clean('weeks', () => query(supabase.from('season_weeks').delete().in('id', weekIds)))
  for (const user of users) await clean('user', async () => {
    const { error } = await supabase.auth.admin.deleteUser(user)
    if (error) throw new Error(error.message)
  })
  globalThis.fetch = nativeFetch
  if (priorProvider === undefined) Deno.env.delete('NBA_CDN_BASE_URL')
  else Deno.env.set('NBA_CDN_BASE_URL', priorProvider)
  await provider.shutdown()
  console.log(JSON.stringify({ scenario: 'real-multiweek-score-boundary', cleanupErrors: errors, reachedAssertions }))
  if (errors.length) throw new Error(errors.join('; '))
}
