import { strict as assert } from 'node:assert'
// eslint-disable-next-line import/no-unresolved
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import { fantasyCalendar } from '../../functions/_shared/schedule.ts'
import { virtualDate } from '../../../scripts/season-sim/virtual-clock.mjs'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const [endpoint, port] of [[api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321'], [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322']]) {
  const url = new URL(endpoint)
  assert.ok(/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535 &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === port, `Only isolated loopback port ${port} is allowed`)
}
const calendarYear = Number(Deno.args[0] ?? 2024)
assert.ok([2024, 2025].includes(calendarYear))
const skipped = Deno.args[1] === 'skip'
const sourcePath = `tests/fixtures/calendar/espn-${calendarYear}-${calendarYear + 1}.json`
const sourceBytes = await Deno.readFile(sourcePath)
const source = JSON.parse(new TextDecoder().decode(sourceBytes))
assert.equal(source.provenance, 'REAL-DERIVED')
const weeks = fantasyCalendar(source.games.filter((game: any) => !game.cupFinal).map((game: any) => game.gameDate))
assert.equal(weeks.length, 24)
assert.ok(Date.parse(weeks[16].week_end) - Date.parse(weeks[16].week_start) > 7 * 86400000)
const NativeDate = Date
const day = (date: string, offset: number) => new NativeDate(NativeDate.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
let clock = { simMs: NativeDate.now(), realMs: NativeDate.now(), rate: 0 }
let clockInstalled = false
const adminDb = new URL(db)
adminDb.username = 'supabase_admin'
let cronJobs = ''
async function sql(statement: string) {
  const result = await new Deno.Command('psql', { args: [adminDb.href, '-XqAt', '-v', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = result.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const output = await result.output()
  assert.equal(output.code, 0, new TextDecoder().decode(output.stderr))
  return new TextDecoder().decode(output.stdout).trim()
}
async function move(at: string) {
  clock = { simMs: NativeDate.parse(at), realMs: NativeDate.now(), rate: 0 }
  await sql(`UPDATE season_sim.clock SET sim_ms=${clock.simMs},real_ms=${clock.realMs},rate=0,cap_ms=NULL WHERE singleton`)
}
const q = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const league = crypto.randomUUID(), season = crypto.randomUUID()
const members: string[] = Array.from({ length: 8 }, () => crypto.randomUUID())
const players: string[] = Array.from({ length: 16 }, () => crypto.randomUUID())
const personIds = players.map(() => 1000000000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000000)
const users: string[] = [], gameIds: string[] = []
const password = `Synthetic-${crypto.randomUUID()}!`
type FeedGame = { id: string; providerId: string; date: string; week: number; final: boolean; points: number[] }
const games = new Map<string, FeedGame>()
let active: FeedGame | undefined
const requests: string[] = []
const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
  const path = new URL(request.url).pathname
  requests.push(path)
  assert.ok(active)
  const entry = path.endsWith('todaysScoreboard_00.json') ? active
    : [...games.values()].find(game => path.endsWith(`boxscore_${game.providerId}.json`))
  assert.ok(entry, path)
  const status = entry.final ? 3 : 2
  const team = (home: boolean) => ({ teamTricode: home ? 'BOS' : 'MIA', score: 100, players: personIds
    .map((personId, index) => ({ personId, name: `Synthetic Persisted ${personId}`, played: '1', statistics: {
      minutes: 'PT20M00.00S', points: entry.points[index], reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0,
      assists: 0, steals: 0, blocks: 0, turnovers: 0, foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0,
      threePointersMade: 0, threePointersAttempted: 0, freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0,
    } })).filter((_, index) => home ? index < 8 : index >= 8) })
  const game = { gameId: entry.providerId, gameStatus: status, gameStatusText: entry.final ? 'Final' : 'Q1',
    period: entry.final ? 4 : 1, gameClock: entry.final ? 'PT00M00.00S' : 'PT08M00.00S', homeTeam: team(true), awayTeam: team(false) }
  if (path.endsWith('todaysScoreboard_00.json')) return Response.json({ scoreboard: { games: [game] } })
  return Response.json({ game })
})
const origin = `http://127.0.0.1:${provider.addr.port}`
Deno.env.set('NBA_CDN_BASE_URL', origin)
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.ok([api, origin].includes(url.origin), 'Only isolated fixture services receive requests')
  return nativeFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { chooseBestAssignments } = await import('../../functions/lineup-optimizer/assignments.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
const { ingestTick } = await import('../../functions/live-poll/runner.ts')
const { withWorkContext } = await import('../../functions/_shared/workContext.ts')
const client = createClient(api, Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
const events: any[] = []
let channel: any
let year = 0, autoRows = 0, explicitRows = 0, liveTicks = 0
const excluded = new Set<string>()
const frozen = new Map<string, any>()
const expected = new Map<string, number>()
const maxExpected = new Map<string, number>()
let excludedPrimary = ''
async function excludedSnapshot() {
  const ids = [...excluded].map(id => `'${id}'`).join(',')
  return sql(`SELECT jsonb_build_object(
    'matchups', (SELECT coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('xmin',m.xmin::text) ORDER BY id),'[]')
      FROM matchups m WHERE league_season_id='${season}' AND (home_member_id IN (${ids}) OR away_member_id IN (${ids}))),
    'standings', (SELECT coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('xmin',s.xmin::text) ORDER BY id),'[]')
      FROM standings s WHERE league_season_id='${season}' AND member_id IN (${ids})))`)
}
const readMatchups = () => q(supabase.from('matchups').select('*').eq('league_season_id', season).order('id'))
const resultState = (row: any) => [row.id, row.home_member_id, row.away_member_id, row.home_points, row.away_points,
  row.home_max_possible_points, row.away_max_possible_points, row.winner_member_id, row.is_finalized, row.finalized_at]
async function assertExcluded(week: number) {
  assert.deepEqual(JSON.parse(await excludedSnapshot()), JSON.parse(excludedPrimary), 'Scoring never writes primary matchup or standings rows for excluded members')
  const rows = await readMatchups()
  assert.equal(rows.filter((row: any) => row.week_number >= 20 && row.matchup_type === 'regular_season').length, 0,
    'Regular-season generation must stop before playoff weeks')
  for (const [id, state] of frozen) assert.deepEqual(resultState(rows.find((row: any) => row.id === id)), state,
    'Eliminated teams retain their frozen result, points, max and winner')
  const visible = await q(client.from('matchups').select('*').eq('league_season_id', season).eq('is_voided', false)
    .lte('week_number', week).or(`end_week_number.gte.${week},week_number.eq.${week}`))
  for (const row of visible) {
    assert.ok(!excluded.has(row.home_member_id) && !excluded.has(row.away_member_id), 'Authenticated matchup API excludes eliminated and non-playoff members')
  }
  const standings = await q(supabase.from('standings').select('week_number,member_id,wins,losses,ties,points_for,points_against,max_possible_points').eq('league_season_id', season).gte('week_number', 20))
  assert.deepEqual(standings, [], 'Playoff lineups never create regular standings for any member')
  assert.equal(await sql(`SELECT count(*) FROM private.score_week_certificates WHERE league_season_id='${season}' AND week_number IN (22,24)`), '0',
    'Continuation weeks never create phantom scoring certificates')
}
async function tick() {
  const holder = await q(supabase.rpc('try_live_poll_lease', { p_lock_key: 779001, p_ttl_seconds: 90 }))
  assert.ok(holder)
  try {
    const result = await withWorkContext({ livePollHolder: holder, signal: AbortSignal.timeout(18000) }, () => ingestTick(holder))
    assert.deepEqual(result.failures, [])
    assert.ok(result.lines >= 16 && result.lines % 16 === 0, 'Real box-score ingestion includes every surviving and excluded player')
    liveTicks++
  } finally {
    assert.equal(await q(supabase.rpc('release_live_poll_lease', { p_lock_key: 779001, p_holder_id: holder })), true)
  }
}
async function boundary() {
  const reports = await runSeasonBoundary(new Date(), league)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].error, undefined, JSON.stringify(reports))
  return reports[0].actions
}
async function lineups(date: string, week: number, auto: boolean) {
  for (let index = 0; index < members.length; index++) {
    if (auto && games.has(date)) {
      const assignments = chooseBestAssignments(['UTIL'], players.slice(index * 2, index * 2 + 2).map((playerId, position) => ({
        playerId, eligiblePositions: ['PG'], projected: position ? 1 : 2, avoidInLineup: false,
      })), () => true)
      await q(supabase.rpc('auto_set_lineup_service_atomic', { p_league_id: league, p_league_season_id: season,
        p_member_id: members[index], p_game_date: date, p_assignments: assignments.map(row => ({ player_id: row.playerId, slot_type: row.slotType, is_auto_set: true })) }))
      autoRows++
    } else {
      await q(supabase.from('weekly_lineups').insert(players.slice(index * 2, index * 2 + 2).map((player_id, position) => ({
        player_id, member_id: members[index], league_id: league, league_season_id: season, week_number: week,
        game_date: date, slot_type: position ? 'BE' as const : 'UTIL' as const, is_auto_set: false,
      }))))
      explicitRows += 2
    }
  }
}
try {
  for (let candidate = 6601; candidate < 6701; candidate++) {
    if (!(await q(supabase.from('season_weeks').select('id').eq('season_year', candidate))).length) { year = candidate; break }
  }
  assert.ok(year)
  for (const member of members) {
    const { data, error } = await supabase.auth.admin.createUser({ email: `eliminated-${member}@example.test`, password,
      email_confirm: true, user_metadata: { username: `elim_${member.replaceAll('-', '').slice(0, 16)}` } })
    if (error) throw error
    users.push(data.user!.id)
  }
  const login = await client.auth.signInWithPassword({ email: `eliminated-${members[0]}@example.test`, password })
  if (login.error) throw login.error
  clock.simMs = NativeDate.parse(`${weeks[0].week_start}T12:00:00Z`)
  cronJobs = await sql("SELECT coalesce(jsonb_agg(to_jsonb(job) ORDER BY jobid),'[]') FROM cron.job job")
  const clockSource = await Deno.readTextFile('scripts/season-sim/clock.sql')
  await sql(clockSource.slice(clockSource.indexOf('BEGIN;')).replaceAll(":'sim_ms'", String(clock.simMs))
    .replaceAll(":'real_ms'", String(clock.realMs)).replaceAll(":'rate'", '0').replaceAll(":'cap_ms'", 'NULL'))
  clockInstalled = true
  globalThis.Date = virtualDate(NativeDate, () => clock)
  await q(supabase.from('leagues').insert({ id: league, slug: league, name: 'Synthetic eliminated lineup scoring', commissioner_id: users[0],
    status: 'active', team_limit: 8, scoring_settings: { points: 1 }, playoff_start_week: 20, playoff_entrants: 6, playoff_round_lengths: [1, 2, 2] }))
  await q(supabase.from('league_members').insert(members.map((id, index) => ({ id, league_id: league, user_id: users[index],
    role: index ? 'manager' as const : 'commissioner' as const, team_name: `Persisted ${index}` }))))
  await q(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  await q(supabase.from('season_weeks').insert(weeks.map(week => ({ ...week, season_year: year }))))
  if (skipped) await q(client.rpc('update_league_settings_atomic', { p_league_id: league, p_settings: { skipped_weeks: [1] } }))
  await q(supabase.from('lineup_slot_templates').delete().eq('league_id', league))
  await q(supabase.from('lineup_slot_templates').insert({ league_id: league, slot_type: 'UTIL', slot_count: 1 }))
  await q(supabase.from('players').insert(players.map((id, index) => ({ id, nba_id: String(personIds[index]), first_name: 'Synthetic',
    last_name: `Persisted ${personIds[index]}`, nba_team: index < 8 ? 'BOS' : 'MIA', position: 'PG' as const, eligible_positions: ['PG'] }))))
  await q(supabase.from('roster_players').insert(players.map((player_id, index) => ({ player_id, league_id: league, league_season_id: season,
    member_id: members[Math.floor(index / 2)], acquired_via: 'draft', acquired_at: `${day(weeks[0].week_start, -7)}T12:00:00Z` }))))
  await q(supabase.from('weekly_lineups').delete().eq('league_id', league))
  assert.ok((await boundary()).some(action => action.includes('matchups')))
  const allDates = weeks.filter(week => week.week_number >= 20).flatMap(week => {
    const dates = []
    for (let date = week.week_start; date <= week.week_end; date = day(date, 1)) dates.push({ date, week: week.week_number })
    return dates
  })
  const scoringDates = new Set(source.games.filter((game: any) => !game.cupFinal).map((game: any) => game.gameDate))
  for (const { date, week } of [{ date: weeks[18].week_start, week: 19 }, ...allDates.filter(row => scoringDates.has(row.date))]) {
    const id = crypto.randomUUID(), providerId = `002-eliminated-${id}`
    const entry = { id, providerId, date, week, final: false, points: players.map(() => 0) }
    games.set(date, entry)
    gameIds.push(id)
    await q(supabase.from('nba_games').insert({ id, nba_game_id: providerId, game_date: date, game_time: `${date}T23:00:00Z`,
      season_year: year, week_number: week, home_team: 'BOS', away_team: 'MIA', status: 'Scheduled' }))
  }
  for (const [index, { date, week }] of allDates.entries()) await lineups(date, week, index % 2 === 1)
  await lineups(weeks[18].week_start, 19, false)
  const persisted = await q(supabase.from('weekly_lineups').select('*').eq('league_season_id', season).gte('week_number', 20).order('id'))
  for (const member of members) for (const { date } of allDates) assert.ok(persisted.some((row: any) => row.member_id === member && row.game_date === date))
  assert.ok(persisted.some((row: any) => row.is_auto_set) && persisted.some((row: any) => !row.is_auto_set))
  active = games.get(weeks[18].week_start)!
  active.final = true
  active.points = players.map((_, index) => 80 - Math.floor(index / 2) * 10 + index % 2 * 3)
  await syncStatsGame(await q(supabase.from('nba_games').select('*').eq('id', active.id).single()))
  await move(`${weeks[19].week_start}T12:00:00Z`)
  await syncScores(league)
  await move(`${day(weeks[19].week_start, 3)}T12:00:00Z`)
  assert.ok((await boundary()).includes('bracket-generated'))
  const seeded = await q(supabase.from('league_seasons').select('playoff_bracket_seed_ids').eq('id', season).single())
  const seeds: string[] = seeded.playoff_bracket_seed_ids
  assert.equal(seeds.length, 6)
  for (const member of members) if (!seeds.includes(member)) excluded.add(member)
  const regularStandings = await q(supabase.from('standings').select('member_id,week_number,wins,losses,ties,points_for,points_against,max_possible_points')
    .eq('league_season_id', season).order('week_number').order('member_id'))
  assert.equal(regularStandings.length, (19 - Number(skipped)) * 8)
  const lastGame = [...games.values()].sort((a, b) => a.date.localeCompare(b.date)).at(-1)!
  globalThis.Date = NativeDate
  channel = client.channel(`eliminated-${league}`, { config: { broadcast: { ack: true } } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matchups', filter: `league_season_id=eq.${season}` }, (payload: any) => events.push(payload))
  await new Promise<void>((resolve, reject) => {
    let joined = false, ready = false
    const streamStates: unknown[] = []
    const timer = setTimeout(() => reject(new Error(`Postgres stream did not become ready: ${JSON.stringify(streamStates)}`)), 15000)
    const done = () => { if (joined && ready) { clearTimeout(timer); resolve() } }
    channel.on('system', {}, (payload: any) => { streamStates.push(payload); if (payload.extension === 'postgres_changes' && payload.status === 'ok') { ready = true; done() } })
    channel.subscribe((status: string) => { streamStates.push(status); if (status === 'SUBSCRIBED') { joined = true; done() } })
  })
  globalThis.Date = virtualDate(NativeDate, () => clock)
  const firstPlayoff = (await readMatchups()).find((row: any) => row.week_number === 20)!
  await syncScores(league, new Date(), { recoverStats: false })
  const initialBarrierUntil = performance.now() + 15000
  while (!events.some(event => event.new?.id === firstPlayoff.id && event.new?.home_points === 0) && performance.now() < initialBarrierUntil) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(events.some(event => event.new?.id === firstPlayoff.id && event.new?.home_points === 0), 'The first actual score publication drains earlier fixture events')
  let previousWinners = seeds.slice(0, 2)
  for (const [round, start, end] of [[1, 20, 20], [2, 21, 22], [3, 23, 24]]) {
    excludedPrimary = await excludedSnapshot()
    const matchups = (await readMatchups()).filter((row: any) => row.week_number === start && !row.is_voided)
    assert.equal(matchups.length, round === 3 ? 1 : 2)
    const participants = matchups.flatMap((row: any) => [row.home_member_id, row.away_member_id])
    if (round === 1) assert.deepEqual([...participants].sort(), seeds.slice(2).sort(), 'First two seeds receive byes')
    else assert.deepEqual([...participants].sort(), [...previousWinners].sort(), 'Only prior winners and byes advance')
    for (const id of participants) { expected.set(id, 0); maxExpected.set(id, 0) }
    const frozenCertificates = await sql(`SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('xmin',c.xmin::text) ORDER BY week_number),'[]') FROM private.score_week_certificates c WHERE league_season_id='${season}' AND week_number>=20 AND week_number<${start}`)
    const frozenRevisions = await sql(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY scope),'[]') FROM private.score_input_revisions r WHERE scope LIKE 'result:${season}:%' AND split_part(scope,':',3)::int>=20 AND split_part(scope,':',3)::int<${start}`)
    const marker = events.length
    for (const { date, week } of allDates.filter(row => row.week >= start && row.week <= end)) {
      active = games.get(date)
      if (!active) continue
      active.points = players.map((_, index) => excluded.has(members[Math.floor(index / 2)]) ? 10000 + index : 80 - Math.floor(index / 2) * 10 + index % 2 * 3)
      const backfill = NativeDate.parse(`${date}T23:10:00Z`) < clock.simMs
      active.final = backfill
      if (backfill) {
        await syncStatsGame(await q(supabase.from('nba_games').select('*').eq('id', active.id).single()))
        await syncScores(league, new Date(), { recoverStats: false })
      } else {
        await move(`${date}T23:10:00Z`)
        await q(supabase.from('nba_games').update({ status: 'InProgress' }).eq('id', active.id))
        await tick()
      }
      for (const member of participants) {
        expected.set(member, expected.get(member)! + active.points[members.indexOf(member) * 2])
        maxExpected.set(member, maxExpected.get(member)! + active.points[members.indexOf(member) * 2 + 1])
      }
      const scored = await readMatchups()
      for (const row of matchups) {
        const actual = scored.find((item: any) => item.id === row.id)
        assert.equal(Number(actual.home_points), expected.get(row.home_member_id), 'Only this participant starter enters live home points')
        assert.equal(Number(actual.away_points), expected.get(row.away_member_id), 'Only this participant starter enters live away points')
      }
      if (!backfill) { active.final = true; await tick() }
      assert.equal(await sql(`SELECT count(*) FROM player_game_stats WHERE game_id='${active.id}'`), '16')
      await assertExcluded(week)
    }
    await move(`${day(weeks[end - 1].week_end, 1)}T12:00:00Z`)
    await syncScores(league)
    const decided = (await readMatchups()).filter((row: any) => row.week_number === start)
    for (const row of decided) {
      assert.equal(row.is_finalized, true)
      assert.equal(Number(row.home_points), expected.get(row.home_member_id))
      assert.equal(Number(row.away_points), expected.get(row.away_member_id))
      assert.equal(Number(row.home_max_possible_points), maxExpected.get(row.home_member_id))
      assert.equal(Number(row.away_max_possible_points), maxExpected.get(row.away_member_id))
      assert.equal(row.winner_member_id, Number(row.home_points) > Number(row.away_points) ? row.home_member_id : row.away_member_id)
    }
    assert.equal(await sql(`SELECT count(*) FROM private.score_week_certificates WHERE league_season_id='${season}' AND week_number=${start}`), '1')
    assert.equal(await sql(`SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('xmin',c.xmin::text) ORDER BY week_number),'[]') FROM private.score_week_certificates c WHERE league_season_id='${season}' AND week_number>=20 AND week_number<${start}`), frozenCertificates, 'Consumed-round certificates stay frozen')
    assert.equal(await sql(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY scope),'[]') FROM private.score_input_revisions r WHERE scope LIKE 'result:${season}:%' AND split_part(scope,':',3)::int>=20 AND split_part(scope,':',3)::int<${start}`), frozenRevisions, 'Consumed score revisions never advance')
    const last = decided[0]
    const until = performance.now() + 15000
    while (!events.slice(marker).some(event => event.new?.id === last.id && event.new?.is_finalized) && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(events.slice(marker).some(event => event.new?.id === last.id && event.new?.is_finalized), 'Actual active-matchup changes provide a Realtime delivery barrier')
    assert.deepEqual(events.slice(marker).filter(event => frozen.has(event.new?.id) || excluded.has(event.new?.home_member_id) || excluded.has(event.new?.away_member_id)), [], 'Realtime emits no changes for excluded members')
    for (const row of decided) {
      excluded.add(row.winner_member_id === row.home_member_id ? row.away_member_id : row.home_member_id)
      frozen.set(row.id, resultState(row))
    }
    previousWinners = [...(round === 1 ? seeds.slice(0, 2) : []), ...decided.map((row: any) => row.winner_member_id)]
    const currentStandings = await q(supabase.from('standings').select('member_id,week_number,wins,losses,ties,points_for,points_against,max_possible_points')
      .eq('league_season_id', season).order('week_number').order('member_id'))
    assert.deepEqual(currentStandings, regularStandings, 'Eliminated and non-playoff lineups never change regular standings')
    await move(`${day(weeks[end - 1].week_end, 3)}T13:00:00Z`)
    const actions = await boundary()
    assert.ok(actions.includes(round === 1 ? 'round-created' : round === 2 ? 'final-created' : 'season-advanced'), JSON.stringify(actions))
    console.log(JSON.stringify({ provenance: 'SYNTHETIC', calendar: calendarYear, skipped, round, participants: participants.length,
      excluded: excluded.size, points: decided.map((row: any) => [row.home_points, row.away_points]), liveTicks, autoRows, explicitRows }))
  }
  assert.equal(excluded.size, 7)
  const champion = previousWinners[0]
  assert.equal(champion, seeds.reduce((best, member) => members.indexOf(member) < members.indexOf(best) ? member : best))
  const final = (await readMatchups()).find((row: any) => row.matchup_type === 'playoff_final')
  assert.equal(final.winner_member_id, champion)
  assert.equal((await q(supabase.from('league_seasons').select('is_current').eq('id', season).single())).is_current, false)
  const afterFinal = await excludedSnapshot()
  const certificatesAfterFinal = await sql(`SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('xmin',c.xmin::text) ORDER BY week_number) FROM private.score_week_certificates c WHERE league_season_id='${season}'`)
  const revisionsAfterFinal = await sql(`SELECT jsonb_agg(to_jsonb(r) ORDER BY scope) FROM private.score_input_revisions r WHERE scope LIKE 'result:${season}:%'`)
  const afterFinalEvents = events.length
  const loser = final.home_member_id === champion ? final.away_member_id : final.home_member_id
  const loserPlayer = members.indexOf(loser) * 2
  active = lastGame
  for (const points of [100000, 200000]) {
    active.points[loserPlayer] = points
    await syncStatsGame(await q(supabase.from('nba_games').select('*').eq('id', active.id).single()))
    await syncScores(league, new Date(), { recoverStats: false })
  }
  assert.equal((await q(supabase.from('player_game_stats').select('points').eq('game_id', active.id).eq('player_id', players[loserPlayer]).single())).points, 200000)
  assert.equal(await channel.send({ type: 'broadcast', event: 'after-final', payload: { completed: true } }), 'ok', 'The actual subscription remains connected after final-loser imports')
  assert.equal(await excludedSnapshot(), afterFinal, 'The final loser cannot restart fantasy scoring after the champion is recorded')
  assert.equal(await sql(`SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('xmin',c.xmin::text) ORDER BY week_number) FROM private.score_week_certificates c WHERE league_season_id='${season}'`), certificatesAfterFinal)
  assert.equal(await sql(`SELECT jsonb_agg(to_jsonb(r) ORDER BY scope) FROM private.score_input_revisions r WHERE scope LIKE 'result:${season}:%'`), revisionsAfterFinal)
  assert.deepEqual(events.slice(afterFinalEvents), [], 'No old-season matchup event follows the final loser stat imports')
  assert.deepEqual(await q(supabase.from('weekly_lineups').select('*').eq('league_season_id', season).gte('week_number', 20).order('id')),
    persisted, 'Every playoff lineup remains persisted after elimination and champion finalization')
  console.log(JSON.stringify({ calendar: calendarYear, calendarProvenance: source.provenance,
    calendarSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes))).map(value => value.toString(16).padStart(2, '0')).join(''),
    fixtureProvenance: 'SYNTHETIC', skipped, weeks: weeks.length, mergedWeek: weeks[16], playoffDates: allDates.length,
    liveTicks, requests: requests.length, autoRows, explicitRows, persistedLineupRows: persisted.length,
    persistedAutoRows: persisted.filter((row: any) => row.is_auto_set).length,
    champion, excluded: excluded.size, realtimeEvents: events.length }))
} finally {
  if (channel) await client.removeChannel(channel)
  globalThis.Date = NativeDate
  globalThis.fetch = nativeFetch
  if (clockInstalled) {
    const restore = await Deno.readTextFile('scripts/season-sim/restore-clock.sql')
    await sql(restore.slice(restore.indexOf('BEGIN;')))
    assert.equal(await sql("SELECT prosrc FROM pg_proc WHERE oid='pg_catalog.clock_timestamp()'::regprocedure"), 'clock_timestamp')
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    await sql(`INSERT INTO cron.job SELECT * FROM jsonb_populate_recordset(NULL::cron.job,${quote(cronJobs)}::jsonb)`)
    assert.equal(await sql("SELECT coalesce(jsonb_agg(to_jsonb(job) ORDER BY jobid),'[]') FROM cron.job job"), cronJobs,
      'Clock restoration preserves every original cron job field and ID')
  }
  await q(supabase.from('leagues').delete().eq('id', league))
  if (gameIds.length) {
    await q(supabase.from('player_game_stats').delete().in('game_id', gameIds))
    await q(supabase.from('nba_games').delete().in('id', gameIds))
  }
  await q(supabase.from('players').delete().in('id', players))
  if (year) await q(supabase.from('season_weeks').delete().eq('season_year', year))
  for (const user of users) { const { error } = await supabase.auth.admin.deleteUser(user); if (error) throw error }
  await client.auth.signOut()
  await provider.shutdown()
  console.log(JSON.stringify({ cleanup: 'owned fixtures removed; native clock restored' }))
}
