import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../../../types/database.ts'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const key = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
assert.ok(key)
const internalToken = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(internalToken)
const workerHost = Deno.env.get('E2E_INVOCATION_WORKER_HOST') ?? 'host.docker.internal'
assert.ok(['host.lima.internal', 'host.docker.internal'].includes(workerHost))
const admin = createClient<Database>(api, key, { auth: { persistSession: false, autoRefreshToken: false } })
async function query<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
async function sql(command: string) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c', command], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 15000): Promise<T> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await read()
    if (ready(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Owned tipoff observation timed out')
}
const contexts: string[] = []
const projectionPlayers: string[][] = []
let delayMember = '', delayedAt = 0, failContext = '', failFinish = false
const delayedResponses = new Set<() => void>()
const proxy = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const path = new URL(request.url).pathname
  const bytes = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
  const body = bytes?.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {}
  if (path.endsWith('/get_pre_tipoff_lineup_context')) {
    contexts.push(body.p_member_id)
    if (body.p_member_id === failContext) {
      failContext = ''
      return Response.json({ message: 'Synthetic context service unavailable' }, { status: 503 })
    }
  }
  if (path.endsWith('/get_league_projection_rows')) projectionPlayers.push(body.p_player_ids)
  if (path.endsWith('/finish_lineup_tipoff_dispatch') && failFinish) {
    failFinish = false
    return Response.json({ message: 'Synthetic finish service unavailable' }, { status: 503 })
  }
  const headers = new Headers(request.headers)
  headers.delete('host')
  const target = new URL(new URL(request.url).pathname + new URL(request.url).search, api)
  const response = await fetch(target, { method: request.method, headers, body: bytes })
  const data = await response.arrayBuffer()
  if (path.endsWith('/get_pre_tipoff_lineup_context') && body.p_member_id === delayMember) {
    delayMember = ''
    delayedAt = Date.now()
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); request.signal.removeEventListener('abort', done); delayedResponses.delete(done); resolve() }
      const timer = setTimeout(done, 50000)
      delayedResponses.add(done)
      request.signal.addEventListener('abort', done, { once: true })
    })
  }
  return new Response(response.status === 204 ? null : data, { status: response.status, headers: response.headers })
})
const proxyOrigin = `http://127.0.0.1:${proxy.addr.port}`
Deno.env.set('SUPABASE_URL', proxyOrigin)
type RootResult = { optimized: number; failed: number; claimed: boolean; errors: string[] }
const roots: { status: number; result: RootResult }[] = []
const nativeServe = Deno.serve
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
let worker: Deno.HttpServer<Deno.NetAddr> | undefined
Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
  worker = nativeServe({ hostname: '0.0.0.0', port: 0, onListen() {} }, async (request, info) => {
    const response = await handler(request, info)
    if (response.headers.get('content-type')?.includes('application/json')) roots.push({ status: response.status, result: await response.clone().json() })
    return response
  })
  return worker
} })
try { await import('../../functions/lineup-optimizer/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
assert.ok(worker)
const workerBase = `http://${workerHost}:${worker.addr.port}`
const fixtures: Fixture[] = []
class Fixture {
  token = crypto.randomUUID().replaceAll('-', '')
  league = crypto.randomUUID()
  season = crypto.randomUUID()
  game = crypto.randomUUID()
  members = Array.from({ length: 101 }, () => crypto.randomUUID())
  players = [crypto.randomUUID(), crypto.randomUUID()]
  users: string[] = []
  year = 0
  date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  tipoff = ''
  async seed() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = 12000 + crypto.getRandomValues(new Uint32Array(1))[0] % 100000
      if (!(await query(admin.from('season_weeks').select('id').eq('season_year', candidate)))?.length) { this.year = candidate; break }
    }
    assert.ok(this.year)
    const ids = this.members.map(() => crypto.randomUUID())
    await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) SELECT id,id::text||'@example.test',jsonb_build_object('username',id::text) FROM unnest(ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]) id`)
    this.users = ids
    await query(admin.from('leagues').insert({ id: this.league, slug: `tipoff-${this.token}`, name: 'Owned resumable tipoff', commissioner_id: ids[0], status: 'active', team_limit: this.members.length }))
    await query(admin.from('league_seasons').insert({ id: this.season, league_id: this.league, season_year: this.year, is_current: true }))
    await query(admin.from('league_members').insert(this.members.map((id, side) => ({ id, league_id: this.league, user_id: ids[side], role: side ? 'manager' as const : 'commissioner' as const, team_name: `Tipoff ${side}` }))))
    await query(admin.from('season_weeks').insert({ season_year: this.year, week_number: 1, week_start: this.date, week_end: this.date }))
    await query(admin.from('players').insert(this.players.map((id, side) => ({ id, first_name: 'Tipoff', last_name: `${this.token}-${side}`, position: 'PG' as const, eligible_positions: ['PG'], nba_team: side ? 'MIA' : 'BOS' }))))
    await query(admin.from('roster_players').insert(this.players.map((player_id, side) => ({ player_id, league_id: this.league, league_season_id: this.season, member_id: this.members[side], acquired_via: 'draft' }))))
    this.tipoff = new Date(Date.now() + 120000).toISOString()
    await query(admin.from('nba_games').insert({ id: this.game, nba_game_id: `002-tipoff-${this.token}`, game_date: this.date, season_year: this.year, week_number: 1, home_team: 'BOS', away_team: 'MIA', status: 'Scheduled', game_time: this.tipoff, started_at: null }))
  }
  async queue() {
    const due = await query(admin.from('nba_games').select('id').eq('status', 'Scheduled').gt('game_time', new Date().toISOString()).lte('game_time', new Date(Date.now() + 120000).toISOString()))
    assert.deepEqual(due?.map(row => row.id), [this.game], 'Only the owned tipoff may dispatch')
    await sql(`BEGIN; SELECT set_config('app.supabase_url','${workerBase}',true); SELECT set_config('app.edge_internal_token','${internalToken}',true); SELECT invoke_pre_tipoff_optimizer_if_due(); COMMIT`)
  }
  async dispatch() { return await query(admin.from('lineup_tipoff_dispatches').select('token,status,lease_until,input_revision,error').eq('tipoff_at', this.tipoff).single()) }
  async completed() {
    const revision = (await this.dispatch())?.input_revision
    if (revision == null) return []
    return await query(admin.from('lineup_tipoff_members').select('member_id,completed_at').eq('tipoff_at', this.tipoff).eq('input_revision', revision).order('member_id'))
  }
  async cleanup() {
    await query(admin.from('lineup_tipoff_members').delete().eq('tipoff_at', this.tipoff))
    await query(admin.from('lineup_tipoff_dispatches').delete().eq('tipoff_at', this.tipoff))
    await query(admin.from('leagues').delete().eq('id', this.league))
    await query(admin.from('nba_games').delete().eq('id', this.game))
    await query(admin.from('players').delete().in('id', this.players))
    if (this.year) await query(admin.from('season_weeks').delete().eq('season_year', this.year))
    if (this.users.length) await sql(`DELETE FROM auth.users WHERE id=ANY(ARRAY[${this.users.map(id => `'${id}'::uuid`).join(',')}])`)
    this.users = []
  }
}
let child: Deno.ChildProcess | null = null
try {
  const first = new Fixture(); fixtures.push(first); await first.seed()
  delayMember = first.members[0]; failFinish = true
  await first.queue()
  await waitFor(async () => delayedAt, value => value > 0)
  const original = await first.dispatch(); assert.ok(original)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, delayedAt + 46000 - Date.now())))
  await first.queue()
  assert.equal((await first.dispatch())?.token, original.token, 'A slow real context RPC must not lose its active claim')
  await waitFor(async () => roots.length, count => count === 1, 20000)
  assert.equal(roots[0].status, 500)
  assert.equal(roots[0].result.optimized, 2)
  assert.match(roots[0].result.errors.join(';'), /Synthetic finish service unavailable/)
  assert.equal((await first.completed())?.length, 101, 'The worker must drain more than one batch')
  assert.equal(contexts.length, 101)
  assert.equal(projectionPlayers.length, 2, 'Empty teams must not load all-player projections')
  const contextsBefore = contexts.length, projectionsBefore = projectionPlayers.length
  const unfinished = await first.dispatch(); assert.ok(unfinished?.lease_until)
  const waitingAt = Date.now()
  await waitFor(async () => Date.now(), now => now > Date.parse(unfinished.lease_until!) + 100, 60000)
  assert.ok(Date.now() - waitingAt >= 30000)
  await first.queue()
  await waitFor(async () => roots.length, count => count === 2)
  assert.equal(roots[1].status, 200); assert.equal(roots[1].result.optimized, 0)
  assert.equal(contexts.length, contextsBefore); assert.equal(projectionPlayers.length, projectionsBefore)
  assert.equal((await first.dispatch())?.input_revision, original.input_revision)
  assert.equal((await first.dispatch())?.status, 'succeeded')
  console.log(JSON.stringify({ case: 'fifty-second context retains lease, 101 teams complete, failed finish resumes without full reads', completed: 101, contextReads: contexts.length, projectionReads: projectionPlayers.length, waitedMs: Date.now() - waitingAt, roots }))

  failContext = first.members[0]
  await query(admin.from('players').update({ injury_status: 'Out' }).eq('id', first.players[0]))
  await first.queue(); await waitFor(async () => roots.length, count => count === 3)
  assert.equal(roots[2].status, 500); assert.equal(roots[2].result.failed, 1)
  assert.match((await first.dispatch())?.error ?? '', /Synthetic context service unavailable/)
  const beforeRetry = contexts.length
  await first.queue(); await waitFor(async () => roots.length, count => count === 4)
  assert.equal(roots[3].status, 200)
  assert.equal(contexts.length - beforeRetry, 1, 'Only the failed team may repeat context work')
  assert.equal((await first.completed())?.filter(row => row.member_id === first.members[0]).length, 1)
  const lineup = await query(admin.from('weekly_lineups').select('player_id').eq('league_id', first.league))
  assert.deepEqual(lineup?.map(row => row.player_id), [first.players[1]])
  console.log(JSON.stringify({ case: 'changed inputs refresh, healthy teams persist, only failed team retries', retryContextReads: contexts.length - beforeRetry }))
  await first.cleanup()

  const crashed = new Fixture(); fixtures.push(crashed); await crashed.seed()
  delayMember = crashed.members[0]; delayedAt = 0
  const claim = crypto.randomUUID()
  await sql(`INSERT INTO lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until,input_fingerprint) VALUES('${crashed.tipoff}','${crashed.date}','queued','${claim}',clock_timestamp()+interval '45 seconds',private.pre_tipoff_input_fingerprint('${crashed.date}'))`)
  child = new Deno.Command('deno', { args: ['run', '--no-lock', '--allow-env', '--allow-net=127.0.0.1,localhost', '--allow-read', 'supabase/tests/db/pre-tipoff-crash-worker.ts', crashed.tipoff, claim], env: { SUPABASE_URL: proxyOrigin }, stdout: 'null', stderr: 'piped' }).spawn()
  await waitFor(async () => ({ delayedAt, completed: await crashed.completed() }),
    observation => observation.delayedAt > 0 && !!observation.completed?.length)
  child.kill('SIGTERM'); const childResult = await child.status; assert.notEqual(childResult.code, 0); child = null
  const held = await crashed.dispatch(); assert.ok(held?.lease_until)
  await crashed.queue(); assert.equal((await crashed.dispatch())?.token, claim)
  const crashedWait = Date.now()
  await waitFor(async () => Date.now(), now => now > Date.parse(held.lease_until!) + 100, 60000)
  assert.ok(Date.now() - crashedWait > 30000)
  const doneBefore = await crashed.completed(); assert.ok(doneBefore?.length)
  const readsBefore = contexts.length
  const rootCount = roots.length
  await crashed.queue(); await waitFor(async () => roots.length, count => count === rootCount + 1)
  assert.equal(roots.at(-1)?.status, 200)
  assert.equal(contexts.length - readsBefore, 101 - doneBefore.length)
  const doneAfter = await crashed.completed(); assert.equal(doneAfter?.length, 101)
  assert.deepEqual(doneAfter?.filter(row => doneBefore.some(old => old.member_id === row.member_id)), doneBefore)
  console.log(JSON.stringify({ case: 'genuine worker death preserves progress through natural lease expiry', crashExit: childResult.code, preservedTeams: doneBefore.length, remainingContextReads: contexts.length - readsBefore, completed: doneAfter?.length }))
  await crashed.cleanup()

  const deadline = new Fixture(); fixtures.push(deadline); await deadline.seed()
  deadline.tipoff = new Date(Date.now() - 53000).toISOString()
  await query(admin.from('nba_games').update({ game_time: deadline.tipoff }).eq('id', deadline.game))
  const deadlineToken = crypto.randomUUID()
  await query(admin.from('lineup_tipoff_dispatches').insert({ tipoff_at: deadline.tipoff, game_date: deadline.date,
    status: 'queued', token: deadlineToken, lease_until: new Date(Date.now() + 45000).toISOString() }))
  delayMember = deadline.members[0]
  const deadlineStarted = Date.now()
  const response = await fetch(`http://127.0.0.1:${worker.addr.port}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-function-token': internalToken },
    body: JSON.stringify({ mode: 'pre_tipoff', tipoffAt: deadline.tipoff, token: deadlineToken }) })
  const result = await response.json()
  assert.equal(response.status, 500)
  assert.match(result.errors.join(';'), /work deadline/)
  assert.ok(Date.now() - deadlineStarted < 7000, 'The actual tipoff window must bound slow work')
  assert.equal((await deadline.completed())?.some(row => row.member_id === deadline.members[0]), false)
  console.log(JSON.stringify({ case: 'real tipoff deadline aborts slow context and records failure', elapsedMs: Date.now() - deadlineStarted, result }))
  for (const release of delayedResponses) release()
  await deadline.cleanup()

  const edge = new Fixture(); fixtures.push(edge); await edge.seed()
  const edgeToken = crypto.randomUUID()
  await query(admin.from('lineup_tipoff_dispatches').insert({ tipoff_at: edge.tipoff, game_date: edge.date,
    status: 'queued', token: edgeToken, lease_until: new Date(Date.now() + 45000).toISOString() }))
  const edgeStarted = Date.now()
  const edgeResponse = await fetch(`${api}/functions/v1/lineup-optimizer`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-function-token': internalToken },
    body: JSON.stringify({ mode: 'pre_tipoff', tipoffAt: edge.tipoff, token: edgeToken }) })
  const edgeResult = await edgeResponse.json()
  assert.equal(edgeResponse.status, 200, JSON.stringify(edgeResult))
  assert.equal(edgeResult.optimized, 2); assert.equal(edgeResult.failed, 0)
  assert.equal((await edge.completed())?.length, 101)
  assert.equal((await edge.dispatch())?.status, 'succeeded')
  console.log(JSON.stringify({ case: 'actual local Edge drains 101 teams within platform limits', elapsedMs: Date.now() - edgeStarted, result: edgeResult }))
  await edge.cleanup()
} catch (error) {
  console.error('Tipoff regression failed:', error)
  throw error
} finally {
  if (child) { child.kill('SIGTERM'); await child.status }
  await worker.shutdown()
  for (const release of delayedResponses) release()
  await proxy.shutdown()
  Deno.env.set('SUPABASE_URL', api)
  for (const fixture of fixtures) if (fixture.users.length) await fixture.cleanup()
  console.log(JSON.stringify({ cleanup: 'owned tipoff fixtures, users and servers removed' }))
}
