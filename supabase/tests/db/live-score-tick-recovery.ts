import { strict as assert } from 'node:assert'
import { liveIngestionProvider } from './live-ingestion-provider.ts'

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
const origin = 'http://127.0.0.1:57380'
const provider = Deno.serve({ hostname: '127.0.0.1', port: 57380, onListen() {} }, liveIngestionProvider())
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/static/json`)
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { runLivePoll } = await import('../../functions/live-poll/runner.ts')
const { runEdgeInvocation } = await import('../../functions/_shared/syncRuns.ts')
const league = crypto.randomUUID(), season = crypto.randomUUID(), game = crypto.randomUUID()
const members = [crypto.randomUUID(), crypto.randomUUID()]
const players = [crypto.randomUUID(), crypto.randomUUID()]
const personIds = [0, 1].map(side => 900000000 + crypto.getRandomValues(new Uint32Array(1))[0] + side)
const providerGameId = `002${String(crypto.getRandomValues(new Uint32Array(1))[0] % 100000000).padStart(8, '0')}`
const users: string[] = []
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const day = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
let year = 0, armed = false, rejectedAt = 0
const invocationKeys: string[] = []
const requestIds: number[] = []
const faultName = `live_score_fault_${league.replaceAll('-', '')}`
let faultCreated = false
const publications: { status: number; points: number; at: number }[] = []
const nativeFetch = globalThis.fetch.bind(globalThis)
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
async function invoke() {
  const key = crypto.randomUUID()
  const requestId = -Math.floor(1 + Math.random() * 1_000_000_000_000)
  invocationKeys.push(key)
  requestIds.push(requestId)
  await sql(`INSERT INTO public.edge_invocations(function_name, invocation_key, request_id) VALUES('live-poll','${key}',${requestId})`)
  const response = await runEdgeInvocation('live-poll', new Request(`${api}/functions/v1/live-poll`, {
    method: 'POST', headers: { 'x-pancake-invocation-id': key },
  }), runLivePoll)
  const result = await response.json()
  await sql(`INSERT INTO net._http_response(id,status_code,content_type,headers,content,timed_out,created)
    VALUES(${requestId},${response.status},'application/json','{}','{}',false,now());
    UPDATE public.edge_invocations SET queued_at=now()-interval '2 minutes' WHERE invocation_key='${key}';
    SELECT private.reconcile_edge_invocations()`)
  const outcome = JSON.parse(await sql(`SELECT json_build_object('worker_status',inv.worker_status,'status_code',inv.status_code,
    'reconciled',inv.reconciled_at IS NOT NULL,'dispatch_job_key',inv.dispatch_job_key,'sync_status',run.status,'sync_error',run.error)
    FROM public.edge_invocations inv JOIN public.sync_runs run ON run.id=inv.sync_run_id WHERE inv.invocation_key='${key}'`))
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', response: response.status, result, outcome }))
  return { response, result, outcome }
}
async function control(mode: string) {
  const response = await nativeFetch(`${origin}/control`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gameId: providerGameId, homePersonId: personIds[0], awayPersonId: personIds[1], mode }) })
  assert.equal(response.status, 200)
  await response.text()
}
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.ok([api, origin].includes(url.origin))
  const payload = url.pathname.endsWith('/rpc/update_score_points_atomic')
    ? await (input instanceof Request ? input.clone() : new Request(input, init)).json() : null
  const response = await nativeFetch(input, init)
  if (payload) publications.push({ status: response.status, points: payload.p_matchups[0].home_points, at: Date.now() })
  if (armed && url.pathname.endsWith('/player_game_stats') && url.searchParams.get('select')?.includes('points,rebounds')) {
    armed = false
    await response.clone().json()
    await q(supabase.from('player_game_stats').update({ points: 777 }).eq('game_id', game).eq('player_id', players[0]))
    rejectedAt = Date.now()
    await control('final')
  }
  return response
}
try {
  for (let candidate = 9101; candidate < 9201; candidate++) {
    if (!(await q(supabase.from('season_weeks').select('id').eq('season_year', candidate)))?.length) {
      year = candidate
      break
    }
  }
  assert.ok(year)
  for (let side = 0; side < 2; side++) {
    const { data, error } = await supabase.auth.admin.createUser({ email: `live-overlap-${members[side]}@example.test`,
      password: `Synthetic-${crypto.randomUUID()}!`, email_confirm: true,
      user_metadata: { username: `overlap_${members[side].replaceAll('-', '').slice(0, 16)}` } })
    if (error) throw error
    assert.ok(data.user)
    users.push(data.user.id)
  }
  await q(supabase.from('leagues').insert({ id: league, name: 'Synthetic live overlap', slug: league,
    commissioner_id: users[0], status: 'active', scoring_settings: { points: 1 } }))
  await q(supabase.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  await q(supabase.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: users[side],
    role: side ? 'manager' as const : 'commissioner' as const, team_name: `Side ${side}` }))))
  await q(supabase.from('season_weeks').insert({ season_year: year, week_number: 1, week_start: day(-1), week_end: day(5) }))
  await q(supabase.from('players').insert(players.map((id, side) => ({ id, first_name: 'Synthetic', last_name: id,
    position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? 'MIA' : 'BOS', nba_id: String(personIds[side]) }))))
  await q(supabase.from('roster_players').insert(players.map((player_id, side) => ({ player_id, league_id: league,
    league_season_id: season, member_id: members[side], acquired_via: 'draft', acquired_at: `${day(-2)}T12:00:00Z` }))))
  await q(supabase.from('nba_games').insert({ id: game, nba_game_id: providerGameId, season_year: year,
    week_number: 1, game_date: today, game_time: `${today}T00:00:00Z`, status: 'InProgress', home_team: 'BOS', away_team: 'MIA' }))
  await q(supabase.from('player_game_stats').insert(players.map((player_id, side) => ({ player_id, game_id: game,
    season_year: year, week_number: 1, points: side ? 10 : 20, did_not_play: false }))))
  await q(supabase.from('weekly_lineups').insert(players.map((player_id, side) => ({ player_id, league_id: league,
    league_season_id: season, member_id: members[side], week_number: 1, game_date: today, slot_type: 'PG' as const, is_auto_set: false }))))
  await q(supabase.from('matchups').insert({ league_id: league, league_season_id: season, week_number: 1,
    home_member_id: members[0], away_member_id: members[1], matchup_type: 'regular_season', home_points: 0, away_points: 0 }))
  await control('active')
  armed = true
  const started = Date.now()
  const { response, result, outcome } = await invoke()
  assert.equal(response.status, 200, 'A recovered stale publication must not fail its worker')
  assert.equal(result.ticks, 2)
  assert.deepEqual(result.failures, [])
  assert.equal(result.scoreRetries, 1)
  assert.deepEqual(publications.slice(0, 2).map(row => [row.status, row.points]), [[409, 11], [200, 777]])
  const sameTickRecoveryMs = publications[1].at - rejectedAt
  assert.ok(sameTickRecoveryMs >= 0 && sameTickRecoveryMs < 18_000)
  assert.deepEqual(outcome, { worker_status: 'success', status_code: 200, reconciled: true,
    dispatch_job_key: null, sync_status: 'success', sync_error: null })
  const final = await q(supabase.from('matchups').select('home_points,away_points,is_finalized').eq('league_season_id', season).single())
  assert.deepEqual(final, { home_points: 12, away_points: 1, is_finalized: true })
  const recoveryMs = Date.now() - rejectedAt
  assert.ok(rejectedAt && recoveryMs >= 18_000 && recoveryMs < 25_000)
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', worker: 'actual runLivePoll', elapsedMs: Date.now() - started,
    recoveryMs, sameTickRecoveryMs, ticks: result.ticks, failures: result.failures.length, final, outcome }))
  await q(supabase.from('matchups').update({ home_points: 0 }).eq('league_season_id', season))
  await q(supabase.from('nba_games').update({ stats_synced_at: null }).eq('id', game))
  await sql(`UPDATE private.live_poll_game_state SET stats_attempted_at=NULL WHERE game_id='${game}'`)
  assert.ok((await q(supabase.rpc('get_live_poll_work')))?.some(row => row.id === game && row.needs_stats))
  await sql(`CREATE FUNCTION public.${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic genuine score failure' USING ERRCODE='PT409'; END; $$;
    CREATE TRIGGER ${faultName} BEFORE UPDATE OF home_points ON public.matchups FOR EACH ROW
    WHEN (OLD.league_id='${league}'::uuid) EXECUTE FUNCTION public.${faultName}()`)
  faultCreated = true
  const failed = await invoke()
  assert.equal(failed.response.status, 500, 'A genuine scorer error must fail its worker')
  assert.equal(failed.result.scoreRetries, 0)
  assert.ok(failed.result.failures.some((failure: string) => failure.includes('Score sync failed')))
  assert.equal(failed.outcome.worker_status, 'failed')
  assert.equal(failed.outcome.sync_status, 'failed')
  assert.equal(failed.outcome.status_code, 500)
  assert.equal(failed.outcome.reconciled, true)
  assert.equal(failed.outcome.dispatch_job_key, null)
} finally {
  armed = false
  globalThis.fetch = nativeFetch
  if (faultCreated) await sql(`DROP TRIGGER ${faultName} ON public.matchups; DROP FUNCTION public.${faultName}()`)
  if (invocationKeys.length) await sql(`DELETE FROM public.sync_runs WHERE id IN (SELECT sync_run_id FROM public.edge_invocations
    WHERE invocation_key IN (${invocationKeys.map(key => `'${key}'`).join(',')}));
    DELETE FROM public.edge_invocations WHERE invocation_key IN (${invocationKeys.map(key => `'${key}'`).join(',')});
    DELETE FROM net._http_response WHERE id IN (${requestIds.join(',')})`)
  await q(supabase.from('leagues').delete().eq('id', league))
  await q(supabase.from('player_game_stats').delete().eq('game_id', game))
  await q(supabase.from('nba_games').delete().eq('id', game))
  await q(supabase.from('players').delete().in('id', players))
  if (year) await q(supabase.from('season_weeks').delete().eq('season_year', year))
  for (const user of users) {
    const { error } = await supabase.auth.admin.deleteUser(user)
    if (error) throw error
  }
  await provider.shutdown()
}
