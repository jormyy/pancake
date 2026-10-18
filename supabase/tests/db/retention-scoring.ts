import { strict as assert } from 'node:assert'

// Probe the actual global retention function only inside an unconditional rollback.
const api = Deno.env.get('SUPABASE_URL')
const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db, 'Root must inject local API and database settings')
assert.ok(['localhost', '127.0.0.1'].includes(new URL(api!).hostname))
assert.ok(['localhost', '127.0.0.1'].includes(new URL(db!).hostname))
const apiOrigin = new URL(api!).origin
const originalFetch = globalThis.fetch.bind(globalThis)
let externalAttempts = 0
let phase = 'setup'
const scoreWrites: Array<{ phase: string; name: string }> = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== apiOrigin) { externalAttempts++; throw new Error('External requests are forbidden') }
  const method = init && 'method' in init ? init.method : input instanceof Request ? input.method : 'GET'
  const name = url.pathname.split('/').at(-1) ?? ''
  if (method !== 'GET' && ['update_score_points_atomic', 'finalize_score_week_atomic'].includes(name)) {
    scoreWrites.push({ phase, name })
  }
  return await originalFetch(input, init)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
async function query(operation: any): Promise<any> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const uuid = () => crypto.randomUUID()
const token = uuid().replaceAll('-', '')
const league = uuid()
const seasons: string[] = [uuid(), uuid(), uuid()] // retired old, supported previous, supported current
const members = [uuid(), uuid()]
const players = [uuid(), uuid()]
const userIds: string[] = []
const weekIds: string[] = []
const gameIds: string[] = []
const insertedLineupIds: string[] = []
const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const addDays = (d: string, offset: number) => new Date(Date.parse(`${d}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
const starts = [addDays(day, -70), addDays(day, -56), addDays(day, -42)]
const idsSql = (values: string[]) => values.map((value) => { assert.match(value, /^[0-9a-f-]{36}$/); return `'${value}'::uuid` }).join(',')
const own = `'${league}'::uuid`
const old = `'${seasons[0]}'::uuid`
let year = 0
let hasRetiredTable = false
let retiredKey = 'league_season_id'
let finalReport: any

// Each call uses a fresh connection. Errors or timeout close that connection and roll back open transactions.
async function sql(statement: string): Promise<string> {
  const process = new Deno.Command('psql', {
    args: [db!, '-X', '-qAt', '--set', 'ON_ERROR_STOP=1', '-f', '-'],
    env: { PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=20000' },
    stdin: 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn()
  const timer = setTimeout(() => { try { process.kill('SIGTERM') } catch {} }, 20000)
  try {
    const input = process.stdin.getWriter()
    await input.write(new TextEncoder().encode(statement + '\n'))
    await input.close()
    const result = await process.output()
    if (!result.success) throw new Error(`Owned SQL operation fails: ${new TextDecoder().decode(result.stderr)}`)
    return new TextDecoder().decode(result.stdout).trim()
  } finally { clearTimeout(timer) }
}
async function sqlJson(statement: string): Promise<any> { return JSON.parse(await sql(statement)) }
function snapshotSql() {
  const retired = hasRetiredTable
    ? `(SELECT to_jsonb(retired) FROM private.retired_score_inputs retired WHERE retired.${retiredKey} = ${old})`
    : 'NULL::jsonb'
  return `SELECT jsonb_build_object(
    'lineups', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.weekly_lineups r WHERE r.league_id = ${own}), '[]'::jsonb),
    'standings', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.standings r WHERE r.league_id = ${own}), '[]'::jsonb),
    'matchups', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.matchups r WHERE r.league_id = ${own}), '[]'::jsonb),
    'certificates', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.league_season_id,r.week_number) FROM private.score_week_certificates r WHERE r.league_season_id IN (${idsSql(seasons)})), '[]'::jsonb),
    'retired', ${retired})`
}
const snapshot = () => sqlJson(snapshotSql())
const seasonRows = (state: any, kind: string, season: string) => state[kind].filter((r: any) => r.league_season_id === season)
function resultFields(state: any, season: string) {
  return { matchups: seasonRows(state, 'matchups', season), standings: seasonRows(state, 'standings', season) }
}
function standing(state: any, season: string, member: string, week: number) {
  const row = state.standings.find((r: any) => r.league_season_id === season && r.member_id === member && r.week_number === week)
  assert.ok(row, 'An actual standings row must exist')
  return row
}
function assertOriginalResult(state: any, index: number) {
  const home = standing(state, seasons[index], members[0], 2)
  assert.equal(home.wins, 1); assert.equal(home.losses, 1); assert.equal(home.ties, 0)
  assert.equal(Number(home.points_for), 40 + 2 * index)
  assert.equal(Number(home.points_against), 60 + 2 * index)
  const matches = seasonRows(state, 'matchups', seasons[index]).sort((a: any,b: any) => a.week_number-b.week_number)
  assert.equal(matches.length, 2)
  assert.ok(matches.every((r: any) => r.is_finalized))
  assert.equal(matches[0].winner_member_id, members[0]); assert.equal(matches[1].winner_member_id, members[1])
}
async function certificateFresh(season: string, week: number): Promise<boolean> {
  assert.ok(seasons.includes(season))
  return await sqlJson(`SELECT to_jsonb(COALESCE((SELECT certificate.input_token IS NOT DISTINCT FROM private.score_input_token(certificate.league_season_id, certificate.week_number)
    FROM private.score_week_certificates certificate WHERE certificate.league_season_id = '${season}'::uuid AND certificate.week_number = ${week}), false))`)
}

try {
  hasRetiredTable = (await sql("SELECT to_regclass('private.retired_score_inputs') IS NOT NULL")) === 't'
  if (hasRetiredTable) {
    const columns = await sqlJson("SELECT jsonb_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'private' AND table_name = 'retired_score_inputs'")
    if (!columns.includes(retiredKey) && columns.includes('season_id')) retiredKey = 'season_id'
    assert.ok(columns.includes(retiredKey) && columns.includes('retired_at'), 'Adapt the draft to the actual retirement schema before running')
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const trial = 3000 + crypto.getRandomValues(new Uint32Array(1))[0] % 4000
    const years = [trial, trial + 1, trial + 2]
    const used = await query(supabase.from('season_weeks').select('id').in('season_year', years))
    const existingSeasons = await query(supabase.from('league_seasons').select('id').in('season_year', years))
    const existingGames = await query(supabase.from('nba_games').select('id').in('season_year', years))
    const priorRevisionScopes = await sqlJson(`SELECT to_jsonb(EXISTS(SELECT 1 FROM private.score_input_revisions WHERE scope IN (
      'calendar:${trial}', 'calendar:${trial+1}', 'calendar:${trial+2}', 'nba:${trial}:1', 'nba:${trial}:2',
      'nba:${trial+1}:1', 'nba:${trial+1}:2', 'nba:${trial+2}:1', 'nba:${trial+2}:2')))`)
    if (!used.length && !existingSeasons.length && !existingGames.length && !priorRevisionScopes) { year = trial; break }
  }
  assert.ok(year, 'Allocate three unused synthetic years')
  for (let side = 0; side < 2; side++) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `retention-${token}-${side}@example.test`, password: `Synthetic-${uuid()}!`, email_confirm: true,
      user_metadata: { username: `retain_${token.slice(0, 15)}_${side}`, display_name: 'Synthetic retention test' },
    })
    if (error) throw new Error(error.message)
    assert.ok(data.user); userIds.push(data.user.id)
  }
  await query(supabase.from('leagues').insert({ id: league, slug: `retention-${token}`, name: 'Synthetic retention integrity',
    commissioner_id: userIds[0], status: 'active', scoring_settings: { points: 1 }, playoff_start_week: 3 }))
  await query(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: userIds[side],
    role: side ? 'manager' as const : 'commissioner' as const, team_name: `Owned side ${side}` }))))
  await query(supabase.from('league_seasons').insert(seasons.map((id, index) => ({ id, league_id: league,
    season_year: year + index, is_current: index === 2, playoff_start_week: 3 }))))
  await query(supabase.from('players').insert(players.map((id, side) => ({ id, first_name: 'Synthetic', last_name: `Retention ${token}-${side}`,
    position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? 'XRA' : 'XRH' }))))
  for (let index = 0; index < 3; index++) {
    const weeks = [0,1].map((offset) => ({ id: uuid(), season_year: year + index, week_number: offset + 1,
      week_start: addDays(starts[index], offset * 7), week_end: addDays(starts[index], offset * 7 + 6) }))
    await query(supabase.from('season_weeks').insert(weeks)); weekIds.push(...weeks.map((r) => r.id))
    await query(supabase.from('roster_players').insert(players.map((player_id, side) => ({ player_id, member_id: members[side],
      league_id: league, league_season_id: seasons[index], acquired_via: 'draft', acquired_at: `${addDays(starts[index], -7)}T12:00:00Z`, is_on_ir: false, is_on_taxi: false }))))
    for (let offset = 0; offset < 2; offset++) {
      const id = uuid(), game_date = addDays(weeks[offset].week_start, 2)
      await query(supabase.from('nba_games').insert({ id, nba_game_id: `002-retention-${token}-${index}-${offset}`,
        season_year: year + index, week_number: offset + 1, game_date, game_time: `${game_date}T19:00:00Z`,
        home_team: 'XRH', away_team: 'XRA', status: 'Final' })); gameIds.push(id)
      const points = offset === 0 ? [30 + index,20 + index] : [10 + index,40 + index]
      await query(supabase.from('player_game_stats').insert(players.map((player_id, side) => ({ player_id, game_id: id,
        season_year: year + index, week_number: offset + 1, game_date, minutes_played: 30, points: points[side],
        rebounds: 0, offensive_rebounds: 0, defensive_rebounds: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0,
        personal_fouls: 0, field_goals_made: 0, field_goals_attempted: 0, three_pointers_made: 0, three_pointers_attempted: 0,
        free_throws_made: 0, free_throws_attempted: 0, plus_minus: 0, double_double: false, triple_double: false, did_not_play: false }))))
      await query(supabase.from('nba_games').update({ stats_synced_at: new Date().toISOString() }).eq('id', id))
      const matchup = uuid()
      await query(supabase.from('matchups').insert({ id: matchup, league_id: league, league_season_id: seasons[index], week_number: offset + 1,
        end_week_number: null, home_member_id: members[0], away_member_id: members[1], matchup_type: 'regular_season', is_finalized: false }))
    }
  }
  // Remove only auto-generated lineups in the new league before setting exact owned lineups.
  await query(supabase.from('weekly_lineups').delete().eq('league_id', league))
  const lineupRows = seasons.flatMap((league_season_id, index) => [0,1].flatMap((offset) => players.map((player_id, side) => ({
    id: uuid(), league_id: league, league_season_id, member_id: members[side], player_id, week_number: offset + 1,
    game_date: addDays(starts[index], offset * 7 + 2), slot_type: 'PG' as const, is_auto_set: false,
  }))))
  await query(supabase.from('weekly_lineups').insert(lineupRows)); insertedLineupIds.push(...lineupRows.map((r) => r.id))
  phase = 'initial real scoring'
  for (const season of seasons) {
    await query(supabase.from('league_seasons').update({ is_current: false }).eq('league_id', league))
    await query(supabase.from('league_seasons').update({ is_current: true }).eq('id', season))
    await syncScores(league)
  }
  const before = await snapshot()
  for (let index = 0; index < 3; index++) {
    assertOriginalResult(before, index)
    for (const week of [1,2]) assert.equal(await certificateFresh(seasons[index], week), true, 'Actual scoring must certify both weeks')
  }
  assert.equal(before.lineups.length, 12)
  assert.equal(before.standings.length, 12)

  // Full production prune runs in a single connection with an unconditional ROLLBACK.
  // No API reads occur inside this transaction; all observations use this same connection.
  const probe = await sqlJson(`BEGIN;
    CREATE TEMP TABLE owned_retention_before ON COMMIT DROP AS ${snapshotSql()};
    DO $probe$ BEGIN PERFORM public.prune_unbounded_history(); END $probe$;
    SELECT jsonb_build_object('before', (SELECT * FROM owned_retention_before), 'after', (${snapshotSql()}));
    ROLLBACK;`)
  assert.deepEqual(probe.before, before)
  assert.deepEqual(await snapshot(), before, 'Rollback must restore every observed owned row and certificate')
  const afterPrune = probe.after
  assert.deepEqual(afterPrune, before, 'Cleanup must preserve every historical row, certificate and retirement state')
  const oldBefore = resultFields(before, seasons[0])
  const removedLineups = seasonRows(before, 'lineups', seasons[0])
  const removedStandings = seasonRows(before, 'standings', seasons[0]).filter((r: any) => r.week_number === 1)
  assert.equal(removedLineups.length, 4)
  assert.equal(removedStandings.length, 2)
  assert.ok(removedLineups.every((r: any) => insertedLineupIds.includes(r.id)))
  assert.ok(hasRetiredTable)
  await sql(`BEGIN;
    SELECT 1 FROM public.league_seasons WHERE id = ${old} AND league_id = ${own} FOR UPDATE;
    INSERT INTO private.retired_score_inputs(${retiredKey}) VALUES(${old});
    DELETE FROM public.weekly_lineups WHERE league_id = ${own} AND league_season_id = ${old} AND id IN (${idsSql(removedLineups.map((r: any) => r.id))});
    DELETE FROM public.standings WHERE league_id = ${own} AND league_season_id = ${old} AND id IN (${idsSql(removedStandings.map((r: any) => r.id))});
    COMMIT;`)
  const legacy = await snapshot()
  const oldPruned = resultFields(legacy, seasons[0])
  assert.deepEqual(oldPruned.matchups, oldBefore.matchups)
  assert.deepEqual(oldPruned.standings, oldBefore.standings.filter((r: any) => r.week_number === 2))
  const staleBefore = await query(supabase.rpc('get_stale_score_weeks', { p_league_season_id: seasons[0], p_through_week: 2 }))
  assert.deepEqual(staleBefore, [], 'Previously retired history stays excluded from replay planning')
  phase = 'legacy retirement replay'
  let replayError: string | null = null
  try { await syncScores(league) } catch (error) { replayError = (error as Error).message }
  const afterReplay = await snapshot()
  assert.deepEqual(resultFields(afterReplay, seasons[0]), oldPruned, 'Lost legacy inputs must preserve every stored result field')
  assert.equal(seasonRows(afterReplay, 'standings', seasons[0]).length, 2, 'No invented zero intermediate snapshots')
  assert.equal(await certificateFresh(seasons[0], 1), false, 'Retired inputs must not gain a falsely fresh certificate')

  // Supported previous season: actual deletion invalidates its cumulative result token.
  const previousWeekOne = seasonRows(afterReplay, 'standings', seasons[1]).filter((r: any) => r.week_number === 1)
  assert.equal(previousWeekOne.length, 2)
  await query(supabase.from('standings').delete().eq('league_season_id', seasons[1]).in('id', previousWeekOne.map((r: any) => r.id)))
  const supportedStale = await query(supabase.rpc('get_stale_score_weeks', { p_league_season_id: seasons[1], p_through_week: 2 }))
  assert.ok(supportedStale.some((r: any) => r.week_number === 1), 'Supported missing snapshot must make the real certificate stale')
  phase = 'supported previous restore'
  await syncScores(league)
  const restored = await snapshot()
  assertOriginalResult(restored, 1)
  assert.equal(seasonRows(restored, 'standings', seasons[1]).length, 4)
  for (const week of [1,2]) assert.equal(await certificateFresh(seasons[1], week), true)
  assert.deepEqual(resultFields(restored, seasons[0]), oldPruned)

  // Supported current season: a real stat correction must still change scores and records.
  await query(supabase.from('player_game_stats').update({ points: 52 }).eq('game_id', gameIds[5]).eq('player_id', players[0]))
  phase = 'current correction'
  await syncScores(league)
  const corrected = await snapshot()
  const current = standing(corrected, seasons[2], members[0], 2)
  assert.equal(Number(current.points_for), 84); assert.equal(current.wins, 2); assert.equal(current.losses, 0)
  const currentWeekTwo = seasonRows(corrected, 'matchups', seasons[2]).find((r: any) => r.week_number === 2)
  assert.equal(Number(currentWeekTwo.home_points), 52); assert.equal(currentWeekTwo.winner_member_id, members[0])
  assert.equal(await certificateFresh(seasons[2], 2), true)
  assert.deepEqual(resultFields(corrected, seasons[0]), oldPruned)

  const direct: any[] = []
  {
    const target = oldPruned.matchups.find((r: any) => r.week_number === 1)
    assert.ok(target)
    const guardedBefore = resultFields(await snapshot(), seasons[0])
    phase = 'direct retired points write'
    const pointsResponse = await supabase.rpc('update_score_points_atomic', { p_league_id: league, p_league_season_id: seasons[0], p_week_number: 1,
      p_matchups: [{ id: target.id, home_points: 999, away_points: 1 }] })
    assert.deepEqual(resultFields(await snapshot(), seasons[0]), guardedBefore, 'Direct points RPC must preserve retired result')
    direct.push({ operation: 'update points', rejected: Boolean(pointsResponse.error), count: pointsResponse.data })
    const freshToken = await sqlJson(`SELECT private.score_input_token(${old}, 1)`)
    assert.ok(freshToken, 'Direct finalization uses actual current revisions, not a deliberately stale token')
    phase = 'direct retired finalization'
    const finalResponse = await supabase.rpc('finalize_score_week_atomic', { p_league_id: league, p_league_season_id: seasons[0], p_week_number: 1,
      p_matchups: [{ id: target.id, home_points: 999, away_points: 1, winner_member_id: members[0],
        home_max_possible_points: 999, away_max_possible_points: 1, input_token: freshToken, score_read_started_at: new Date().toISOString() }],
      p_standings: members.map((member_id) => ({ member_id, wins: 99, losses: 0, ties: 0, points_for: 999, points_against: 1,
        max_possible_points: 999, waiver_priority: 1, created_at: new Date().toISOString() })),
      p_finalized_at: new Date().toISOString(), p_reconciliation_at: new Date().toISOString() })
    assert.deepEqual(resultFields(await snapshot(), seasons[0]), guardedBefore, 'Direct finalization RPC must preserve retired results and snapshots')
    assert.equal(await certificateFresh(seasons[0], 1), false, 'Direct guarded finalization must not manufacture a certificate')
    direct.push({ operation: 'finalize', rejected: Boolean(finalResponse.error), data: finalResponse.data })
  }
  assert.equal(externalAttempts, 0)
  finalReport = { setup: 'New owned fixture only', globalPrune: 'Executed in unconditional rollback; preserves all history and retirement state',
    globalPruneRemovedLineups: 0, globalPruneRemovedSnapshots: 0,
    legacyGuardFixture: 'Only newly allocated owned rows simulate previously retired inputs',
    legacyFixtureRemovedLineups: removedLineups.length, legacyFixtureRemovedSnapshots: removedStandings.length,
    oldFinalBefore: standing(before, seasons[0], members[0], 2), oldFinalAfter: standing(afterReplay, seasons[0], members[0], 2),
    replayError, previousRestore: true, currentCorrection: true, directGuards: direct, externalAttempts,
    scoreWrites, limitation: 'Synthetic complete stat inputs; no provider fetch or lost-lineup reconstruction' }
  console.log(JSON.stringify(finalReport))
} finally {
  phase = 'cleanup'
  const failures: string[] = []
  const clean = async (label: string, action: () => Promise<any>) => {
    try { await action() } catch (error) { failures.push(`${label}: ${(error as Error).message}`) }
  }
  // Cleanup predicates contain only identities allocated in this run.
  if (hasRetiredTable) await clean('own retirement marker', () => sql(`DELETE FROM private.retired_score_inputs WHERE ${retiredKey} IN (${idsSql(seasons)})`))
  await clean('new league', () => query(supabase.from('leagues').delete().eq('id', league)))
  if (gameIds.length) {
    await clean('new stats', () => query(supabase.from('player_game_stats').delete().in('game_id', gameIds)))
    await clean('new games', () => query(supabase.from('nba_games').delete().in('id', gameIds)))
  }
  await clean('new players', () => query(supabase.from('players').delete().in('id', players)))
  if (weekIds.length) await clean('new weeks', () => query(supabase.from('season_weeks').delete().in('id', weekIds)))
  for (const id of userIds) await clean('new user', async () => { const { error } = await supabase.auth.admin.deleteUser(id); if (error) throw error })
  await clean('own revision scopes', () => sql(`DELETE FROM private.score_input_revisions WHERE scope IN (
    'league:${league}', ${seasons.flatMap((s) => [`'season:${s}'`, `'lineup:${s}:1'`, `'lineup:${s}:2'`, `'result:${s}:1'`, `'result:${s}:2'`]).join(',')}
    ${year ? `, 'calendar:${year}', 'calendar:${year+1}', 'calendar:${year+2}', 'nba:${year}:1', 'nba:${year}:2', 'nba:${year+1}:1', 'nba:${year+1}:2', 'nba:${year+2}:1', 'nba:${year+2}:2'` : ''})`))
  // Never reset the global 'players' revision, which can also include other legitimate work.
  globalThis.fetch = originalFetch
  if (failures.length) throw new Error(`Owned fixture cleanup fails: ${failures.join('; ')}`)
  console.log(JSON.stringify({ cleanup: 'Only new owned fixture removed', assertionsReached: Boolean(finalReport) }))
}
