import { strict as assert } from 'node:assert'
// eslint-disable-next-line import/no-unresolved
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../../functions/_shared/database.ts'

const api = Deno.env.get('SUPABASE_URL')!, db = Deno.env.get('SUPABASE_DB_URL')!
for (const [endpoint, port, protocols] of [
  [api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321', ['http:', 'https:']],
  [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322', ['postgres:', 'postgresql:']],
] as const) {
  const url = new URL(endpoint)
  assert.ok(/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535 &&
    ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === port &&
    protocols.some(protocol => protocol === url.protocol), `Refuse a target outside loopback port ${port}`)
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const userClient = createClient<Database>(api, Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
const league = crypto.randomUUID(), season = crypto.randomUUID()
const members = [crypto.randomUUID(), crypto.randomUUID()]
const players = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
const games = [crypto.randomUUID(), crypto.randomUUID()]
const matchups = [crypto.randomUUID(), crypto.randomUUID()]
const users: string[] = []
type MatchupRow = Database['public']['Tables']['matchups']['Row']
const events: MatchupRow[] = []
let channel: ReturnType<typeof userClient.channel> | undefined
const password = `Synthetic-${crypto.randomUUID()}!`
const first = '2026-10-19'
const day = (offset: number) => new Date(Date.parse(`${first}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
const sqlLiteral = (value: string) => "'" + value.replaceAll("'", "''") + "'"
let year = 0
async function q<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
async function sql(command: string) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c', command], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
async function waitForEvent(ready: (row: MatchupRow) => boolean) {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    if (events.some(ready)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`Real matchup stream does not deliver the committed score: ${JSON.stringify(events)}`)
}
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  assert.equal(new URL(input instanceof Request ? input.url : input).origin, api)
  return nativeFetch(input, init)
}
async function assertSkipped() {
  const row = await q(supabase.from('matchups').select('home_points,away_points,is_finalized,is_voided').eq('id', matchups[0]).single())
  assert.equal(row?.is_voided, true)
  assert.equal(row?.is_finalized, false)
  assert.equal(Number(row?.home_points), 0)
  assert.equal(Number(row?.away_points), 0)
  assert.equal(await sql(`SELECT count(*) FROM private.score_week_certificates WHERE league_season_id=${sqlLiteral(season)} AND week_number=1`), '0')
  assert.equal((await q(supabase.from('standings').select('id').eq('league_season_id', season).eq('week_number', 1)))?.length, 0)
  const live = await q(userClient.from('matchups').select('id').eq('league_season_id', season).eq('week_number', 1).eq('is_voided', false))
  assert.deepEqual(live, [], 'Matchups REST API exposes a skipped matchup as live')
}
try {
  for (let candidate = 9601; candidate < 9701; candidate++) {
    if (!(await q(supabase.from('season_weeks').select('id').eq('season_year', candidate)))?.length) { year = candidate; break }
  }
  assert.ok(year)
  for (let side = 0; side < 2; side++) {
    const { data, error } = await supabase.auth.admin.createUser({ email: `skip-${members[side]}@example.test`, password,
      email_confirm: true, user_metadata: { username: `skip_${members[side].replaceAll('-', '').slice(0, 16)}` } })
    if (error) throw error
    assert.ok(data.user)
    users.push(data.user.id)
  }
  await q(supabase.from('leagues').insert({ id: league, name: 'Synthetic skipped opening week', slug: league,
    commissioner_id: users[0], status: 'active', scoring_settings: { points: 1 }, playoff_start_week: 23,
    playoff_entrants: 2, playoff_round_lengths: [1] }))
  await q(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  await q(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: users[side],
    role: side ? 'manager' as const : 'commissioner' as const, team_name: `Side ${side}` }))))
  await q(supabase.from('season_weeks').insert(Array.from({ length: 28 }, (_, index) => ({ season_year: year,
    week_number: index + 1, week_start: day(index * 7), week_end: day(index * 7 + 6) }))))
  await q(supabase.from('lineup_slot_templates').delete().eq('league_id', league))
  await q(supabase.from('lineup_slot_templates').insert({ league_id: league, slot_type: 'UTIL', slot_count: 1 }))
  await q(supabase.from('players').insert(players.map(id => ({ id, first_name: 'Synthetic', last_name: id,
    position: 'PG' as const, eligible_positions: ['PG'], nba_team: 'BOS' }))))
  await q(supabase.from('roster_players').insert(players.map((player_id, index) => ({ player_id, league_id: league,
    league_season_id: season, member_id: members[index === 2 ? 1 : 0], acquired_via: 'draft', acquired_at: `${day(-1)}T12:00:00Z` }))))
  await q(supabase.from('nba_games').insert(games.map((id, index) => ({ id, nba_game_id: `002-skip-${id}`, season_year: year,
    week_number: index + 1, game_date: day(index * 7 + 1), game_time: `${day(index * 7 + 1)}T23:00:00Z`,
    status: index ? 'InProgress' as const : 'Final' as const, home_team: 'BOS', away_team: 'MIA' }))))
  for (let week = 0; week < 2; week++) {
    await q(supabase.from('player_game_stats').insert(players.map((player_id, index) => ({ player_id, game_id: games[week],
      season_year: year, week_number: week + 1, points: week ? [12, 20, 8][index] : [1000, 2000, 500][index], did_not_play: false }))))
    await q(supabase.from('weekly_lineups').insert(players.map((player_id, index) => ({ player_id, league_id: league,
      league_season_id: season, member_id: members[index === 2 ? 1 : 0], week_number: week + 1,
      game_date: day(week * 7 + 1), slot_type: index === 1 ? 'BE' as const : 'UTIL' as const, is_auto_set: false }))))
  }
  await q(supabase.from('nba_games').update({ stats_synced_at: new Date().toISOString() }).eq('id', games[0]))
  await q(supabase.from('matchups').insert(matchups.map((id, index) => ({ id, league_id: league, league_season_id: season,
    week_number: index + 1, home_member_id: members[0], away_member_id: members[1], matchup_type: 'regular_season' as const, home_points: 0, away_points: 0 }))))
  const { data: signedIn, error: signInError } = await userClient.auth.signInWithPassword({ email: `skip-${members[0]}@example.test`, password })
  if (signInError) throw signInError
  assert.ok(signedIn.session)
  await userClient.realtime.setAuth(signedIn.session.access_token)
  await q(userClient.rpc('update_league_settings_atomic', { p_league_id: league, p_settings: { skipped_weeks: [1] } }))
  channel = userClient.channel(`skip-${league}`).on<MatchupRow>('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'matchups', filter: `league_season_id=eq.${season}`,
  }, payload => events.push(payload.new))
  const streamStates: unknown[] = []
  await new Promise<void>((resolve, reject) => {
    let joined = false, postgresReady = false
    const timeout = setTimeout(() => reject(new Error(`Matchup PostgreSQL subscription timed out: ${JSON.stringify(streamStates)}`)), 10_000)
    const ready = () => { if (joined && postgresReady) { clearTimeout(timeout); resolve() } }
    channel!.on('system', {}, payload => {
      streamStates.push(payload)
      if (payload.extension === 'postgres_changes' && payload.status === 'ok') { postgresReady = true; ready() }
    })
    channel!.subscribe(status => {
      streamStates.push(status)
      if (status === 'SUBSCRIBED') { joined = true; ready() }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timeout); reject(new Error(status)) }
    })
  })
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', streamStates }))
  assert.deepEqual((await q(supabase.from('league_seasons').select('skipped_weeks').eq('id', season).single()))?.skipped_weeks, [1])
  assert.equal(await q(supabase.rpc('update_score_points_atomic', { p_league_id: league, p_league_season_id: season, p_week_number: 1,
    p_matchups: [{ id: matchups[0], home_points: 9999, away_points: 0 }] })), 0)
  const token = await q(supabase.rpc('capture_score_inputs', { p_league_season_id: season, p_week_number: 1 }))
  await q(supabase.rpc('finalize_score_week_atomic', { p_league_id: league, p_league_season_id: season, p_week_number: 1,
    p_matchups: [{ id: matchups[0], input_token: token, home_points: 9999, away_points: 0, winner_member_id: members[0] }], p_standings: [] }))
  await syncScores(league, new Date('2026-10-22T18:00:00Z'), { recoverStats: false })
  await assertSkipped()
  await syncScores(league, new Date('2026-10-28T18:00:00Z'), { recoverStats: false })
  const live = await q(userClient.from('matchups').select('home_points,away_points,is_finalized').eq('id', matchups[1]).single())
  assert.equal(Number(live?.home_points), 12)
  assert.equal(Number(live?.away_points), 8)
  assert.equal(live?.is_finalized, false)
  await waitForEvent(row => row.id === matchups[1] && Number(row.home_points) === 12 && !row.is_finalized)
  await q(supabase.from('nba_games').update({ status: 'Final', stats_synced_at: new Date().toISOString() }).eq('id', games[1]))
  await syncScores(league, new Date('2026-11-02T18:00:00Z'), { recoverStats: false })
  const final = await q(userClient.from('matchups').select('home_points,away_points,home_max_possible_points,away_max_possible_points,is_finalized').eq('id', matchups[1]).single())
  assert.equal(final?.is_finalized, true)
  assert.equal(Number(final?.home_points), 12)
  assert.equal(Number(final?.away_points), 8)
  assert.equal(Number(final?.home_max_possible_points), 20)
  assert.equal(Number(final?.away_max_possible_points), 8)
  await waitForEvent(row => row.id === matchups[1] && row.is_finalized && Number(row.home_max_possible_points) === 20)
  assert.ok(!events.some(row => row.id === matchups[0] && !row.is_voided), 'Skipped week appears as live in the stream')
  const standings = await q(supabase.from('standings').select('member_id,week_number,wins,losses,points_for,points_against,max_possible_points').eq('league_season_id', season))
  assert.equal(standings?.length, 2)
  const home = standings!.find(row => row.member_id === members[0])!
  assert.deepEqual([home.week_number, home.wins, home.losses, Number(home.points_for), Number(home.points_against), Number(home.max_possible_points)], [2, 1, 0, 12, 8, 20])
  assert.equal(await sql(`SELECT count(*) FROM private.score_week_certificates WHERE league_season_id=${sqlLiteral(season)} AND week_number=2 AND input_token=private.score_input_token(${sqlLiteral(season)},2)`), '1')
  await assertSkipped()
  await q(supabase.from('matchups').update({ is_finalized: true, home_points: 1000, away_points: 500, winner_member_id: members[0] }).eq('id', matchups[0]))
  await assertSkipped()
  const history = await q(supabase.from('matchups').insert({ league_id: league, league_season_id: season, week_number: 2,
    home_member_id: members[1], away_member_id: members[0], matchup_type: 'regular_season', is_voided: true, is_finalized: true,
    home_points: 500, away_points: 1000, winner_member_id: members[0] }).select('is_voided,is_finalized,home_points').single())
  assert.deepEqual(history, { is_voided: true, is_finalized: true, home_points: 500 }, 'Historical control must retain its scores')
  await syncScores(league, new Date('2026-11-02T18:00:00Z'), { recoverStats: false })
  await sql(`SELECT private.rebuild_regular_standings(${sqlLiteral(league)},${sqlLiteral(season)})`)
  const rebuilt = await q(supabase.from('standings').select('week_number,points_for,points_against').eq('league_season_id', season).eq('member_id', members[0]))
  assert.deepEqual(rebuilt?.map(row => [row.week_number, Number(row.points_for), Number(row.points_against)]), [[2, 12, 8]])
  assert.equal(await sql(`SELECT count(*) FROM private.score_week_certificates WHERE league_season_id=${sqlLiteral(season)} AND week_number=2 AND input_token=private.score_input_token(${sqlLiteral(season)},2)`), '1')
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', calendar: '28 Monday-Sunday weeks beginning 2026-10-19',
    openingGameDate: day(1), skippedWeeks: [1], liveWeek2: live, finalizedWeek2: final, streamEvents: events.length,
    standings, certificateWeek2: 'current', staleSkippedWrite: 'neutralized', voidedHistory: 'retained and excluded' }))
} finally {
  if (channel) await userClient.removeChannel(channel)
  globalThis.fetch = nativeFetch
  await q(supabase.from('leagues').delete().eq('id', league))
  await q(supabase.from('player_game_stats').delete().in('game_id', games))
  await q(supabase.from('nba_games').delete().in('id', games))
  await q(supabase.from('players').delete().in('id', players))
  if (year) await q(supabase.from('season_weeks').delete().eq('season_year', year))
  for (const user of users) {
    const { error } = await supabase.auth.admin.deleteUser(user)
    if (error) throw error
  }
}
