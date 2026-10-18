import { strict as assert } from 'node:assert'

const api = Deno.env.get('SUPABASE_URL')
const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db, 'Root must inject isolated database settings')
assert.ok(['localhost', '127.0.0.1'].includes(new URL(api).hostname))
assert.ok(['localhost', '127.0.0.1'].includes(new URL(db).hostname))
const nativeFetch = globalThis.fetch.bind(globalThis)
type Observation = { table: string; rows: any[] }
let observedPayload: any
let observe = false
let observations: Observation[] = []
let finalizationResponses: { status: number; body: any }[] = []
// Observe actual responses. Never substitute a response or bypass a write.
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, new URL(api).origin, 'Only the isolated API may receive requests')
  if (url.pathname === '/rest/v1/rpc/finalize_score_week_atomic' && init && 'body' in init && typeof init.body === 'string') observedPayload = JSON.parse(init.body)
  const response = await nativeFetch(input, init)
  if (observe && ['/rest/v1/roster_players', '/rest/v1/roster_transactions'].includes(url.pathname)) {
    if (url.searchParams.get('select')?.includes('eligible_positions')) {
      const body = await response.clone().json()
      assert.ok(Array.isArray(body), 'The real roster read must succeed')
      observations.push({ table: url.pathname.split('/').at(-1)!, rows: body })
    }
  }
  if (observe && url.pathname === '/rest/v1/rpc/finalize_score_week_atomic') {
    finalizationResponses.push({ status: response.status, body: await response.clone().json() })
  }
  return response
}

const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { calcWeekMaxPossiblePointsByMember } = await import('../../functions/_shared/scoreLineups.ts')
const query = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const addDays = (date: string, offset: number) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
// Final and fully synced, well outside the stat polling window. No external NBA call is allowed.
const first = addDays(day, -42), gameDate = addDays(first, 2), last = addDays(first, 6)
const acquired = `${addDays(first, -7)}T12:00:00Z`
const uuid = () => crypto.randomUUID()
const token = uuid().replaceAll('-', '')
const leagueIds = [uuid(), uuid()]
const seasonIds = [uuid(), uuid()]
const memberIds = [uuid(), uuid(), uuid(), uuid()]
const playerIds = [uuid(), uuid(), uuid(), uuid(), uuid()]
const gameId = uuid(), availabilityGameId = uuid(), weekId = uuid(), matchupIds = [uuid(), uuid()]
const userIds: string[] = []
let year = 0
let insertedWeek = false

class SqlSession {
  process = new Deno.Command('psql', {
    args: [db!, '-X', '-qAt', '--set', 'ON_ERROR_STOP=1'],
    env: { PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=120000' },
    stdin: 'piped', stdout: 'piped', stderr: 'inherit',
  }).spawn()
  writer = this.process.stdin.getWriter()
  reader = this.process.stdout.getReader()
  buffer = ''
  closed = false
  async sql(statement: string): Promise<string> {
    assert.ok(!this.closed)
    const marker = uuid()
    let timer: number | undefined
    const work = async () => {
      await this.writer.write(new TextEncoder().encode(`${statement}; SELECT '${marker}';\n`))
      while (!this.buffer.includes(marker)) {
        const next = await this.reader.read()
        if (next.done) throw new Error('Own SQL connection closed before its marker')
        this.buffer += new TextDecoder().decode(next.value)
      }
      const result = this.buffer.slice(0, this.buffer.indexOf(marker)).trim()
      this.buffer = this.buffer.slice(this.buffer.indexOf(marker) + marker.length)
      return result
    }
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { try { this.process.kill('SIGTERM') } catch {} reject(new Error('Own SQL statement exceeded 15 seconds')) }, 15000)
      })])
    } finally { clearTimeout(timer) }
  }
  async close() {
    if (this.closed) return
    try { await this.sql('ROLLBACK') } catch { try { this.process.kill('SIGTERM') } catch {} }
    this.closed = true
    try { await this.writer.close() } catch {}
    try { await this.reader.cancel() } catch {}
    await this.process.status
  }
}
const sessions: SqlSession[] = []
const openSql = () => { const session = new SqlSession(); sessions.push(session); return session }
const capture = (index: number) => query(supabase.rpc('capture_score_inputs', { p_league_season_id: seasonIds[index], p_week_number: 1 }))
const stale = (index: number) => query(supabase.rpc('get_stale_score_weeks', { p_league_season_id: seasonIds[index], p_through_week: 1 }))
const matchup = (index: number) => query(supabase.from('matchups').select('home_max_possible_points,away_max_possible_points,is_finalized,score_read_started_at').eq('id', matchupIds[index]).single())
const standing = (index: number) => query(supabase.from('standings').select('max_possible_points').eq('league_season_id', seasonIds[index]).eq('member_id', memberIds[index * 2]).eq('week_number', 1).single())
const rosterRow = (index: number, playerIndex: number, memberIndex: number) => ({ league_id: leagueIds[index], league_season_id: seasonIds[index], member_id: memberIds[memberIndex], player_id: playerIds[playerIndex], acquired_via: 'draft', acquired_at: acquired })
const changeEligibility = (playerIndex: number, eligibility: string) => query(supabase.from('players').update({ eligible_positions: [eligibility as 'PG' | 'SG'] }).eq('id', playerIds[playerIndex]))
const assertOldRead = (table: string) => {
  const read = observations.flatMap((entry) => entry.table === table ? entry.rows : []).find((row) => row.player_id === playerIds[0])
  assert.ok(read, `The real scorer must read the target through ${table}`)
  const metadata = Array.isArray(read.players) ? read.players[0] : read.players
  assert.deepEqual(metadata?.eligible_positions, ['SG'], 'The actual scorer reads committed old eligibility')
}
const expectDeferredScore = async (table: string) => {
  observations = []; finalizationResponses = []; observe = true
  let rejected = false
  try { await syncScores(leagueIds[0]) }
  catch (error) {
    const message = error instanceof AggregateError ? error.errors.map((entry: any) => entry.message).join('; ') : String(error)
    assert.match(message, /Score inputs changed or were not certified/)
    rejected = true
  } finally { observe = false }
  assertOldRead(table)
  assert.ok(rejected, 'The real scorer must reject certification while the eligibility writer remains open')
  assert.ok(finalizationResponses.some((response) => response.status >= 400 && response.body?.code === 'PT409'), 'A real database certification conflict must cause the deferral')
  console.log(JSON.stringify({ scenario: table, oldEligibilityRead: true, certificationDeferred: true }))
}

try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = 3000 + crypto.getRandomValues(new Uint32Array(1))[0] % 5000
    const weeks = await query(supabase.from('season_weeks').select('id').eq('season_year', candidate))
    const seasons = await query(supabase.from('league_seasons').select('id').eq('season_year', candidate))
    if (!weeks.length && !seasons.length) { year = candidate; break }
  }
  assert.ok(year, 'A fixture-only season year must be available')
  for (let side = 0; side < 4; side++) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `player-revision-${token}-${side}@example.test`, password: `Synthetic-${uuid()}!`, email_confirm: true,
      user_metadata: { username: `revision_${token.slice(0, 12)}_${side}`, display_name: 'Synthetic player revision check' },
    })
    if (error) throw new Error(error.message)
    assert.ok(data.user); userIds.push(data.user.id)
  }
  for (let index = 0; index < 2; index++) {
    await query(supabase.from('leagues').insert({ id: leagueIds[index], slug: `player-revision-${token}-${index}`, name: 'Synthetic player revision check', commissioner_id: userIds[index * 2], status: 'active', scoring_settings: { points: 1 } }))
    await query(supabase.from('league_members').insert([0, 1].map((side) => ({ id: memberIds[index * 2 + side], league_id: leagueIds[index], user_id: userIds[index * 2 + side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Synthetic ${side}` }))))
    await query(supabase.from('league_seasons').insert({ id: seasonIds[index], league_id: leagueIds[index], season_year: year, is_current: true }))
    await query(supabase.from('lineup_slot_templates').delete().eq('league_id', leagueIds[index]))
    await query(supabase.from('lineup_slot_templates').insert({ league_id: leagueIds[index], slot_type: 'PG', slot_count: 1 }))
    await query(supabase.from('matchups').insert({ id: matchupIds[index], league_id: leagueIds[index], league_season_id: seasonIds[index], week_number: 1, matchup_type: 'regular_season', home_member_id: memberIds[index * 2], away_member_id: memberIds[index * 2 + 1] }))
  }
  await query(supabase.from('season_weeks').insert({ id: weekId, season_year: year, week_number: 1, week_start: first, week_end: last })); insertedWeek = true
  await query(supabase.from('players').insert(playerIds.map((id, index) => ({ id, first_name: 'Synthetic', last_name: `Revision ${token}-${index}`, position: index === 0 ? 'SG' as const : 'PG' as const, eligible_positions: [index === 0 ? 'SG' : 'PG'], nba_team: 'XRV' }))))
  await query(supabase.from('roster_players').insert([rosterRow(0, 1, 1), rosterRow(1, 2, 2), rosterRow(1, 3, 3)]))
  await query(supabase.from('nba_games').insert({ id: gameId, nba_game_id: `002-revision-${token}`, season_year: year, week_number: 1, game_date: gameDate, game_time: `${gameDate}T19:00:00Z`, home_team: 'XRV', away_team: 'XRW', status: 'Final', stats_synced_at: new Date().toISOString() }))
  await query(supabase.from('player_game_stats').insert(playerIds.slice(0, 4).map((id, index) => ({ player_id: id, game_id: gameId, season_year: year, week_number: 1, game_date: gameDate, points: [10, 5, 7, 4][index], did_not_play: false }))))
  await syncScores(leagueIds[0]); await syncScores(leagueIds[1])
  assert.equal(Number((await matchup(0)).home_max_possible_points), 0)
  assert.equal(Number((await matchup(1)).home_max_possible_points), 7)
  assert.deepEqual(await stale(0), []); assert.deepEqual(await stale(1), [])

  const inspector = openSql()
  assert.equal(await inspector.sql(`SELECT count(*) FROM private.score_input_revisions WHERE scope='player:${playerIds[0]}'`), '1', 'The independent player revision must pre-exist the new link')
  const controlBefore = await capture(1)
  const link = openSql(), eligibility = openSql()
  await link.sql(`BEGIN; INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES('${leagueIds[0]}','${seasonIds[0]}','${memberIds[0]}','${playerIds[0]}','draft','${acquired}')`)
  assert.deepEqual(await query(supabase.from('roster_players').select('id').eq('league_season_id', seasonIds[0]).eq('player_id', playerIds[0])), [], 'The new link remains invisible to the updater and scorer')
  assert.ok(!(`player:${playerIds[0]}` in await capture(0)), 'The invisible link must not appear in dependency keys')
  // UPDATE touches eligibility only. Do not use SELECT FOR UPDATE on the player.
  // The link FK holds KEY SHARE; this non-key update takes NO KEY UPDATE.
  await eligibility.sql(`BEGIN; UPDATE public.players SET eligible_positions=ARRAY['PG']::text[] WHERE id='${playerIds[0]}'; SELECT eligible_positions::text FROM public.players WHERE id='${playerIds[0]}'`)
  // The UPDATE returns before link commit. This proves the required overlap is reachable.
  await link.sql('COMMIT'); await link.close()
  const linkedToken = await capture(0)
  assert.ok(`player:${playerIds[0]}` in linkedToken)
  const beforeDeferred = await matchup(0)
  await expectDeferredScore('roster_players')
  assert.deepEqual(await matchup(0), beforeDeferred, 'Failed certification must not advance the saved result or read boundary')
  await eligibility.sql('COMMIT'); await eligibility.close()
  assert.notDeepEqual(await capture(0), linkedToken, 'The late player commit invalidates the old input token')
  assert.ok((await stale(0)).some((row: any) => row.week_number === 1))
  assert.deepEqual(await capture(1), controlBefore, 'Another season with different players retains its certificate inputs')
  await syncScores(leagueIds[0])
  assert.equal(Number((await matchup(0)).home_max_possible_points), 10)
  assert.equal(Number((await standing(0)).max_possible_points), 10)
  assert.deepEqual(await stale(0), [])
  console.log(JSON.stringify({ scenario: 'overlapping-invisible-link', laterCommitChangesMaxPoints: [0, 10], otherSeasonUnchanged: true }))

  // Historical ownership exists at game time, followed by a real roster deletion.
  await query(supabase.from('roster_transactions').insert([
    { league_id: leagueIds[0], league_season_id: seasonIds[0], member_id: memberIds[0], player_id: playerIds[0], transaction_type: 'draft_won', occurred_at: acquired },
    { league_id: leagueIds[0], league_season_id: seasonIds[0], member_id: memberIds[0], player_id: playerIds[0], transaction_type: 'fa_drop', occurred_at: `${addDays(last, 1)}T12:00:00Z` },
  ]))
  await query(supabase.from('roster_players').delete().eq('league_season_id', seasonIds[0]).eq('player_id', playerIds[0]))
  await changeEligibility(0, 'SG')
  await syncScores(leagueIds[0])
  assert.equal(Number((await matchup(0)).home_max_possible_points), 0)
  await query(supabase.from('league_seasons').update({ is_current: false }).eq('id', seasonIds[0]))
  assert.deepEqual(await query(supabase.from('roster_players').select('id').eq('league_season_id', seasonIds[0]).eq('player_id', playerIds[0])), [])
  const historyToken = await capture(0)
  assert.ok(`player:${playerIds[0]}` in historyToken, 'A transaction-only player remains a dependency')
  assert.deepEqual(await stale(0), [])
  const historicalWriter = openSql()
  await historicalWriter.sql(`BEGIN; UPDATE public.players SET eligible_positions=ARRAY['PG']::text[] WHERE id='${playerIds[0]}'`)
  // A historical season will not replay until a committed stale token exists.
  // While held open, check the actual certifier directly with its actual saved token.
  assert.equal(await inspector.sql(`SELECT private.lock_current_score_inputs('${seasonIds[0]}',1,'${JSON.stringify(historyToken)}'::jsonb)`), 'f')
  await historicalWriter.sql('COMMIT'); await historicalWriter.close()
  assert.notDeepEqual(await capture(0), historyToken)
  assert.ok((await stale(0)).some((row: any) => row.week_number === 1))
  observations = []; observe = true
  try { await syncScores(leagueIds[0]) } finally { observe = false }
  const historyRead = observations.flatMap((entry) => entry.table === 'roster_transactions' ? entry.rows : []).find((row) => row.player_id === playerIds[0])
  assert.ok(historyRead, 'The real scorer must replay a non-current season from retained ownership history')
  assert.equal(Number((await matchup(0)).home_max_possible_points), 10)
  assert.equal(Number((await standing(0)).max_possible_points), 10)
  assert.deepEqual(await stale(0), [])
  console.log(JSON.stringify({ scenario: 'transaction-only-historical-player', replayedMaxPoints: [0, 10], currentRosterAbsent: true }))

  const suffixId = uuid().slice(8)
  const earlyId = '10000000' + suffixId, ownershipId = '20000000' + suffixId, lateId = '30000000' + suffixId
  const happened = `${addDays(gameDate, -1)}T12:00:00Z`
  await query(supabase.from('roster_transactions').insert([
    { id: ownershipId, league_id: leagueIds[0], league_season_id: seasonIds[0], member_id: memberIds[0], player_id: playerIds[0], transaction_type: 'fa_add', occurred_at: happened },
    { id: earlyId, league_id: leagueIds[0], league_season_id: seasonIds[0], member_id: memberIds[0], player_id: playerIds[0], transaction_type: 'taxi_designate', occurred_at: happened },
  ]))
  await syncScores(leagueIds[0])
  assert.equal(Number((await matchup(0)).home_max_possible_points), 10)
  const oldPayload = structuredClone(observedPayload)
  assert.equal(oldPayload.p_league_season_id, seasonIds[0])
  await query(supabase.from('roster_transactions').update({ id: lateId }).eq('id', earlyId))
  const freshMaximum = await calcWeekMaxPossiblePointsByMember(memberIds.slice(0, 2), leagueIds[0], seasonIds[0], year, { points: 1 }, first, last)
  assert.equal(freshMaximum.get(memberIds[0]), 0, 'Equal-time transaction IDs affect actual taxi history order')
  const beforeIdRejection = await matchup(0)
  const rejectedId = await supabase.rpc('finalize_score_week_atomic', oldPayload)
  assert.equal(rejectedId.error?.code, 'PT409', 'An ID-only transaction reorder must invalidate certification')
  assert.deepEqual(await matchup(0), beforeIdRejection)
  await syncScores(leagueIds[0])
  assert.equal(Number((await matchup(0)).home_max_possible_points), 0)
  assert.equal(Number((await standing(0)).max_possible_points), 0)
  console.log(JSON.stringify({ scenario: 'equal-time-transaction-id', oldMaximum: 10, freshMaximum: 0, oldCertificateRejected: true, replayed: true }))

  await query(supabase.from('nba_games').insert({ id: availabilityGameId, nba_game_id: `002-availability-${token}`, season_year: year,
    week_number: 1, game_date: gameDate, home_team: 'XRV', away_team: 'XRW', status: 'Scheduled', game_status_text: 'PPD - postponed' }))
  await syncScores(leagueIds[0]); await syncScores(leagueIds[1])
  await syncScores(leagueIds[0])
  const availabilityPayload = structuredClone(observedPayload)
  const availabilityToken = await capture(0)
  const beforeAvailability = await matchup(0)
  const availabilityWriter = openSql()
  await availabilityWriter.sql(`BEGIN; UPDATE public.nba_games SET game_status_text='7:30 PM ET' WHERE id='${availabilityGameId}'`)
  const rejectedAvailability = await supabase.rpc('finalize_score_week_atomic', availabilityPayload)
  assert.equal(rejectedAvailability.error?.code, 'PT409', 'An in-flight availability-only writer must defer old scoring')
  assert.deepEqual(await matchup(0), beforeAvailability)
  await availabilityWriter.sql('COMMIT'); await availabilityWriter.close()
  assert.notDeepEqual(await capture(0), availabilityToken)
  const committedAvailability = await supabase.rpc('finalize_score_week_atomic', availabilityPayload)
  assert.equal(committedAvailability.error?.code, 'PT409', 'A committed availability change must reject the prior certificate')
  assert.deepEqual(await matchup(0), beforeAvailability)
  await query(supabase.from('nba_games').update({ game_status_text: 'PPD - postponed' }).eq('id', availabilityGameId))
  await syncScores(leagueIds[0]); await syncScores(leagueIds[1])
  assert.deepEqual(await stale(0), []); assert.deepEqual(await stale(1), [])
  console.log(JSON.stringify({ scenario: 'availability-only-writer', concurrentAndCommittedCertificatesRejected: true, resultsPreserved: true }))

  const targetBeforeUnrelated = await capture(0), controlBeforeUnrelated = await capture(1)
  await changeEligibility(4, 'SG')
  assert.deepEqual(await capture(0), targetBeforeUnrelated)
  assert.deepEqual(await capture(1), controlBeforeUnrelated)
  assert.deepEqual(await stale(0), []); assert.deepEqual(await stale(1), [])
  console.log(JSON.stringify({ scenario: 'unrelated-player-control', bothSeasonsUnchanged: true }))
} finally {
  observe = false
  for (const session of sessions) await session.close()
  // Cleanup never changes shared fixture rows. Delete owned revisions after trigger writes.
  const cleanupErrors: unknown[] = []
  const cleanup = async (work: () => Promise<unknown>) => { try { await work() } catch (error) { cleanupErrors.push(error) } }
  for (const leagueId of leagueIds) await cleanup(() => query(supabase.from('leagues').delete().eq('id', leagueId)))
  await cleanup(() => query(supabase.from('player_game_stats').delete().eq('game_id', gameId)))
  await cleanup(() => query(supabase.from('nba_games').delete().in('id', [gameId, availabilityGameId])))
  await cleanup(() => query(supabase.from('players').delete().in('id', playerIds)))
  if (insertedWeek) await cleanup(() => query(supabase.from('season_weeks').delete().eq('id', weekId)))
  for (const userId of userIds) await cleanup(async () => { const { error } = await supabase.auth.admin.deleteUser(userId); if (error) throw error })
  const revisionCleanup = new SqlSession()
  await cleanup(() => revisionCleanup.sql(`DELETE FROM private.score_input_revisions WHERE scope IN (${[
    ...playerIds.map((id) => `player:${id}`), ...leagueIds.map((id) => `league:${id}`),
    ...seasonIds.flatMap((id) => [`season:${id}`, `lineup:${id}:1`, `result:${id}:1`]),
    ...(insertedWeek ? [`calendar:${year}`, `nba:${year}:1`] : []),
  ].map((scope) => `'${scope}'`).join(',')})`))
  await cleanup(() => revisionCleanup.close())
  globalThis.fetch = nativeFetch
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned fixture cleanup failed')
  console.log(JSON.stringify({ cleanup: 'complete', observedOnlyRealResponses: true }))
}
