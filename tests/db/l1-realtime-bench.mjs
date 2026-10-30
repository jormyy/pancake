import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { localKeys, sql, statementSnapshot, statementDelta } from '../../scripts/perf-lab/database.mjs'
import { requireMini, project, ports } from '../../scripts/perf-lab/common.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { setupRequest } from './l1-realtime-setup-retry.mjs'
import { realtimeQueryKind } from './l1-realtime-queries.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
assert.equal(ports.api, 62221)
const [label, mode = 'postgres', profile = 'inventory', duration = '60', frontend, cadence = '2000'] = process.argv.slice(2)
assert.match(label ?? '', /^[a-z0-9-]+$/)
assert.ok(['postgres', 'broadcast'].includes(mode))
assert.ok(['inventory', 'idle', 'live'].includes(profile))
const seconds = Number(duration)
assert.ok(Number.isFinite(seconds) && seconds >= 10)
const writeIntervalMs = Number(cadence)
assert.ok([2000, 20000].includes(writeIntervalMs))
const targetTicks = Math.ceil(seconds * 1000 / writeIntervalMs)
if (frontend) {
  const url = new URL(frontend)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.port, '62284')
  assert.ok(url.hostname.endsWith('.local'))
}
const devices = profile === 'live' ? 20 : 3
const directory = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1/evidence')
await mkdir(directory, { recursive: true })
const file = path.join(directory, `${label}.json`)
const setupRetries = []
const recordSetup = () => writeFile(file, JSON.stringify({ label, status: 'starting', setupRetries, concurrentLanes: true, measurementLock: false }), { mode: 0o600 })
await writeFile(file, JSON.stringify({ label, status: 'starting', setupRetries }), { flag: 'wx', mode: 0o600 })
const keys = await localKeys()
const decoder = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).realtime
const decode = (payload, callback) => decoder.decode(typeof payload === 'string' ? payload
  : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength), callback)
const fixture = JSON.parse(await sql(`SELECT json_build_object(
  'league',(SELECT id FROM public.leagues WHERE deleted_at IS NULL ORDER BY id LIMIT 1),
  'members',(SELECT json_agg(r) FROM (SELECT m.id,m.user_id,u.email,m.league_id FROM public.league_members m JOIN auth.users u ON u.id=m.user_id ORDER BY m.id) r))`))
const members = fixture.members.filter(member => member.league_id === fixture.league)
assert.equal(members.length, 10)
const password = randomBytes(32).toString('hex')
const headers = { apikey: keys.SERVICE_ROLE_KEY, Authorization: `Bearer ${keys.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }
const sessions = []
for (let index = 0; index < devices; index++) {
  const member = members[index % members.length]
  if (index < members.length) {
    const updated = await setupRequest(`${keys.API_URL}/auth/v1/admin/users/${member.user_id}`, {
      method: 'PUT', headers, body: JSON.stringify({ password }), redirect: 'error', signal: AbortSignal.timeout(20000),
    }, { operation: 'password', retries: setupRetries, record: recordSetup })
    assert.ok(updated.ok, `Local password setup fails: ${updated.status}`)
  }
  const login = await setupRequest(`${keys.API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: keys.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: member.email, password }), redirect: 'error', signal: AbortSignal.timeout(20000),
  }, { operation: 'login', retries: setupRetries, record: recordSetup })
  assert.ok(login.ok, `Local sign-in fails: ${login.status}`)
  sessions.push(await login.json())
}
assert.equal(new Set(sessions.map(session => session.access_token)).size, devices)

function containerCpu(name) {
  assert.ok(['supabase_db_pt4bafablel1', 'supabase_realtime_pt4bafablel1'].includes(name))
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath: path.join(homedir(), 'pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock'), path: `/containers/${name}/stats?stream=false&one-shot=true` }, response => {
      const chunks = []
      response.on('data', bytes => chunks.push(bytes))
      response.on('end', () => {
        try {
          assert.equal(response.statusCode, 200)
          resolve(JSON.parse(Buffer.concat(chunks)).cpu_stats.cpu_usage.total_usage)
        } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.setTimeout(10000, () => request.destroy(new Error('Docker stats times out')))
  })
}

async function infrastructure() {
  const names = ['db', 'realtime', 'auth', 'rest', 'kong'].map(service => `supabase_${service}_pt4bafablel1`)
  const format = '{"name":{{json .Name}},"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}},"oomKilled":{{json .State.OOMKilled}},"restarts":{{json .RestartCount}}}'
  const result = await command('docker', ['inspect', '--format', format, ...names])
  const containers = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(containers.length, names.length)
  assert.ok(containers.every(container => container.running), 'The private stack must be running throughout the capture')
  return containers
}

const clients = []
const received = new Set()
const latencies = []
const events = []
const starts = new Map()
const deliveries = []
let messages = 0, bytes = 0, measuring = false
let idleProbing = false
let browser
let liveGame
const joined = new Set()
const pendingApi = new Set()
let readinessProbeDelivered = null
let apiRequests = 0, apiBytes = 0, apiErrors = 0, joins = 0, edgeRequests = 0
let versionRequests = 0
const apiFailures = []
let socketBytesIn = 0, socketBytesOut = 0
let wireMessages = 0
let disconnects = 0
let infrastructureBefore, infrastructureAfter
let joinErrors = 0
const joinTopics = {}
const receive = index => payload => {
  const batch = payload.hints ?? payload.payload?.hints
  if (Array.isArray(batch)) {
    for (const change of batch) receive(index)({ new: change.row })
    return
  }
  if (measuring) {
    messages++
    bytes += Buffer.byteLength(JSON.stringify(payload))
  }
  const row = payload.new ?? payload.data?.record ?? payload.payload?.new ?? payload.payload
  if (row?.topic !== (frontend ? 'version' : 'score') || !row.updated_at) return
  const key = `${index}:${new Date(row.updated_at).toISOString()}`
  if (received.has(key)) return
  received.add(key)
  if (measuring || idleProbing) deliveries.push({ stamp: new Date(row.updated_at).toISOString(), receivedAt: performance.now() })
}
const join = channel => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Subscription times out')), 20000)
  channel.subscribe((status, error) => {
    if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve() }
    else if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) { clearTimeout(timeout); reject(error ?? new Error(status)) }
  })
})

try {
  if (frontend && profile === 'live') {
    liveGame = JSON.parse(await sql(`SELECT to_jsonb(game) FROM public.nba_games game
      JOIN public.league_seasons season ON season.season_year=game.season_year
      WHERE season.league_id='${fixture.league}' AND season.is_current
      ORDER BY abs(game.game_date-current_date),game.id LIMIT 1`))
    assert.ok(liveGame.id)
    await sql(`UPDATE public.nba_games game SET game_date=(now() AT TIME ZONE league.timezone)::date,
      status='InProgress',game_time=now()-interval '1 hour',started_at=now()-interval '1 hour'
      FROM public.leagues league WHERE league.id='${fixture.league}' AND game.id='${liveGame.id}'`)
  }
  const scoresFile = path.join(directory, 'score-fixture.json')
  let scores
  if (frontend) {
    scores = await readFile(scoresFile, 'utf8').then(JSON.parse).catch(async error => {
      if (error.code !== 'ENOENT') throw error
      const rows = JSON.parse(await sql(`SELECT json_agg(row) FROM (SELECT matchup.id,matchup.home_points FROM public.matchups matchup
        JOIN public.league_seasons season ON season.id=matchup.league_season_id
        JOIN public.season_weeks week ON week.season_year=season.season_year AND '2026-10-29' BETWEEN week.week_start AND week.week_end
        WHERE season.league_id='${fixture.league}' AND season.is_current AND NOT matchup.is_voided
          AND week.week_number BETWEEN matchup.week_number AND coalesce(matchup.end_week_number,matchup.week_number) ORDER BY matchup.id) row`))
      assert.equal(rows.length, 5)
      await writeFile(scoresFile, JSON.stringify(rows), { flag: 'wx', mode: 0o600 })
      return rows
    })
    await sql(`UPDATE public.matchups matchup SET home_points=original.home_points FROM jsonb_populate_recordset(NULL::public.matchups,'${JSON.stringify(scores)}') original WHERE matchup.id=original.id`)
  }
  if (frontend) browser = await (await import('playwright')).webkit.launch({ headless: true })
  for (let index = 0; index < devices; index++) {
    if (browser) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 },
        storageState: { cookies: [], origins: [{ origin: frontend, localStorage: [{
          name: `sb-${new URL(frontend).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(sessions[index]),
        }] }] } })
      clients.push({ removeAllChannels: () => context.close() })
      await context.route('**/*', route => new URL(route.request().url()).origin === frontend ? route.continue() : route.abort())
      const page = await context.newPage()
      page.on('request', request => {
        if (/^\/(functions|rest|auth)\/v1\//.test(new URL(request.url()).pathname)) pendingApi.add(request)
      })
      page.on('requestfinished', request => pendingApi.delete(request))
      page.on('requestfailed', request => pendingApi.delete(request))
      page.on('websocket', socket => {
        assert.equal(new URL(socket.url()).host, new URL(frontend).host)
        socket.on('close', () => { joined.delete(index); if (measuring) disconnects++ })
        socket.on('framesent', ({ payload }) => {
          if (measuring) socketBytesOut += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length
          decode(payload, frame => {
            if (measuring && frame.event === 'phx_join') {
              joins++
              const topic = frame.topic.split(':').slice(1, 3).join(':')
              joinTopics[topic] = (joinTopics[topic] ?? 0) + 1
            }
          })
        })
        socket.on('framereceived', ({ payload }) => {
          if (measuring) socketBytesIn += typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length
          decode(payload, frame => {
            if (measuring && (frame.event === 'phx_reply' || frame.event === 'system') && frame.payload?.status === 'error') joinErrors++
            if (frame.event === 'phx_reply' && frame.payload?.status === 'ok'
              && (frame.topic.startsWith('realtime:l1:league:') || frame.topic.startsWith('realtime:league-changes:'))) joined.add(index)
            if (['postgres_changes', 'broadcast'].includes(frame.event)) {
              if (measuring) wireMessages++
              receive(index)(frame.payload)
            }
          })
        })
      })
      page.on('response', response => {
        if (!measuring || !/^\/(functions|rest|auth)\/v1\//.test(new URL(response.url()).pathname)) return
        apiRequests++
        if (new URL(response.url()).pathname.startsWith('/functions/v1/')) edgeRequests++
        if (new URL(response.url()).pathname === '/functions/v1/api/version') versionRequests++
        if (response.status() >= 400) {
          apiErrors++
          apiFailures.push({ at: new Date().toISOString(), path: new URL(response.url()).pathname, status: response.status() })
        }
        void response.body().then(body => { apiBytes += body.length }, () => {})
      })
      await page.goto(frontend + (index % 3 === 2 ? '/roster' : '/'), { waitUntil: 'networkidle', timeout: 60000 })
      assert.ok(!page.url().includes('sign-in'), 'The private browser session must be admitted')
      continue
    }
    const client = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    clients.push(client)
    await client.realtime.setAuth(sessions[index].access_token)
    if (mode === 'postgres') {
      await join(client.channel(`l1-bench:${index}`, { config: { private: true } })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'league_change_hints', filter: `league_id=eq.${fixture.league}` }, receive(index))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'league_members', filter: `league_id=eq.${fixture.league}` }, receive(index))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'leagues', filter: `id=eq.${fixture.league}` }, receive(index))
        .on('postgres_changes', { event: '*', schema: 'public', table: index % 3 === 2 ? 'roster_players' : 'matchup_forecasts', filter: `league_id=eq.${fixture.league}` }, receive(index)))
    } else {
      await join(client.channel(`l1:league:${fixture.league}`, { config: { private: true } }).on('broadcast', { event: 'change' }, receive(index)))
    }
  }
  if (browser) {
    for (let attempt = 0; attempt < 100 && joined.size < devices; attempt++) await delay(100)
    assert.equal(joined.size, devices, 'Every browser must join the league hint stream')
    const stamp = new Date(await sql(`BEGIN;
      UPDATE public.matchups SET home_points=home_points+0.1 WHERE id='${scores[0].id}'; COMMIT;
      SELECT updated_at FROM public.league_change_hints WHERE league_id='${fixture.league}' AND topic='version'`)).toISOString()
    for (let attempt = 0; attempt < 200 && clients.some((_client, index) => !received.has(`${index}:${stamp}`)); attempt++) await delay(100)
    readinessProbeDelivered = clients.filter((_client, index) => received.has(`${index}:${stamp}`)).length
    assert.equal(readinessProbeDelivered, devices, 'Every browser must receive a readiness write before capture')
  }
  await delay(3000)
  for (let attempt = 0; attempt < 100 && pendingApi.size; attempt++) await delay(100)
  assert.equal(pendingApi.size, 0, 'Setup API requests must settle before capture')
  const snapshot = async () => ({
    statements: await statementSnapshot(),
    wal: Number(await sql('SELECT wal_bytes FROM pg_stat_wal')),
    walFpi: Number(await sql('SELECT wal_fpi FROM pg_stat_wal')),
    lsn: await sql('SELECT pg_current_wal_insert_lsn()'),
    dbCpu: await containerCpu('supabase_db_pt4bafablel1'),
    realtimeCpu: await containerCpu('supabase_realtime_pt4bafablel1'),
  })
  let revision = BigInt(await sql(`SELECT coalesce((SELECT revision FROM public.league_change_hints WHERE league_id='${fixture.league}' AND topic='score'),0)`))
  infrastructureBefore = await infrastructure()
  const before = await snapshot()
  const started = performance.now()
  const captureStartedAt = new Date().toISOString()
  await writeFile(file, JSON.stringify({ label, mode, profile, devices, seconds, status: 'capturing', captureStartedAt, setupRetries, concurrentLanes: true, measurementLock: false }), { mode: 0o600 })
  measuring = true
  let ticks = 0
  let midpoint
  const counters = () => ({ apiRequests, apiBytes, edgeRequests, socketBytes: socketBytesIn + socketBytesOut, messages, wireMessages, versionRequests })
  while (ticks < targetTicks && performance.now() - started < seconds * 1000) {
    if (profile !== 'idle') {
      revision += 1n
      const writeStart = performance.now()
      const stamp = await sql(frontend ? `BEGIN;
        UPDATE public.matchups SET home_points=home_points+0.1 WHERE id IN (${scores.map(row => `'${row.id}'`).join(',')});
        COMMIT;
        SELECT updated_at FROM public.league_change_hints WHERE league_id='${fixture.league}' AND topic='version'`
        : `INSERT INTO public.league_change_hints AS hint(league_id,topic,revision,scopes,updated_at)
        VALUES('${fixture.league}','score',${revision},NULL,clock_timestamp()) ON CONFLICT(league_id,topic)
        DO UPDATE SET revision=EXCLUDED.revision,scopes=NULL,updated_at=clock_timestamp() RETURNING updated_at`, { measured: true })
      const key = new Date(stamp).toISOString()
      starts.set(key, writeStart)
      events.push(key)
    }
    ticks++
    await delay(Math.max(0, Math.min(started + ticks * writeIntervalMs - performance.now(), seconds * 1000 - (performance.now() - started))))
    if (ticks === Math.ceil(targetTicks / 2)) midpoint = { snapshot: await snapshot(), elapsedMinutes: (performance.now() - started) / 60000, counters: counters() }
  }
  const after = await snapshot()
  const minutes = (performance.now() - started) / 60000
  infrastructureAfter = await infrastructure()
  const infrastructureChanged = JSON.stringify(infrastructureBefore) !== JSON.stringify(infrastructureAfter)
  assert.equal(infrastructureChanged, false, 'The private stack must not restart during a capture')
  const walInsertBytes = Number(await sql(`SELECT pg_wal_lsn_diff('${after.lsn}','${before.lsn}')`))
  await delay(2000)
  measuring = false
  let idleProbeDelivered = null
  if (browser && profile === 'idle') {
    idleProbing = true
    const writeStart = performance.now()
    const stamp = new Date(await sql(`BEGIN;
      UPDATE public.matchups SET home_points=home_points+0.1 WHERE id='${scores[0].id}'; COMMIT;
      SELECT updated_at FROM public.league_change_hints WHERE league_id='${fixture.league}' AND topic='version'`)).toISOString()
    starts.set(stamp, writeStart)
    for (let attempt = 0; attempt < 100 && clients.some((_client, index) => !received.has(`${index}:${stamp}`)); attempt++) await delay(100)
    idleProbeDelivered = clients.filter((_client, index) => received.has(`${index}:${stamp}`)).length
    assert.equal(idleProbeDelivered, devices, 'Idle browsers must still receive a real update after capture')
    idleProbing = false
  }
  for (const delivery of deliveries) {
    const writeStart = starts.get(delivery.stamp)
    if (writeStart !== undefined) latencies.push(delivery.receivedAt - writeStart)
  }
  const statements = statementDelta(before.statements, after.statements)
  const top = statements.filter(row => row.toplevel)
  const realtime = top.filter(row => realtimeQueryKind(row.query).realtime)
  const summarize = rows => ({ dbMsPerMinute: rows.reduce((total, row) => total + row.total_exec_time, 0) / minutes,
    callsPerMinute: rows.reduce((total, row) => total + row.calls, 0) / minutes,
    buffersPerMinute: rows.reduce((total, row) => total + row.shared_blks_hit + row.shared_blks_read, 0) / minutes })
  const selectCosts = (rows, measuredMinutes) => {
    const rate = kind => {
      const selected = rows.filter(row => row.toplevel && realtimeQueryKind(row.query)[kind])
      return { callsPerMinute: selected.reduce((sum, row) => sum + row.calls, 0) / measuredMinutes,
        buffersPerMinute: selected.reduce((sum, row) => sum + row.shared_blks_hit + row.shared_blks_read, 0) / measuredMinutes }
    }
    return { walPoll: rate('walPoll'), authorize: rate('authorize'), authorizationContext: rate('authorizationContext'), catalog: rate('catalog'),
      callsPerClientMinute: rows.filter(row => row.toplevel).reduce((sum, row) => sum + row.calls, 0) / measuredMinutes / devices }
  }
  const halves = midpoint ? [[before, midpoint.snapshot, midpoint.elapsedMinutes, midpoint.counters],
    [midpoint.snapshot, after, minutes - midpoint.elapsedMinutes, Object.fromEntries(Object.entries(counters()).map(([key, value]) => [key, value - midpoint.counters[key]]))]]
    .map(([first, last, length, counts]) => ({ minutes: length, ...selectCosts(statementDelta(first.statements, last.statements), length),
      ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [`${key}PerClientMinute`, value / length / devices])) })) : []
  const sorted = latencies.toSorted((a, b) => a - b)
  const quantile = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null
  const missing = events.flatMap(stamp => clients.flatMap((_client, index) => received.has(`${index}:${stamp}`) ? [] : [`${index}:${stamp}`]))
  const fallbackMissing = Boolean(liveGame && versionRequests < (devices - Math.floor(devices / 3)) * (Math.floor(seconds / 20) - 2))
  const missedWrites = profile !== 'idle' && events.length !== targetTicks
  const result = { label, mode, profile, seconds, devices, minutes, captureStartedAt,
    status: missing.length || apiErrors || disconnects || joinErrors || infrastructureChanged || fallbackMissing || missedWrites ? 'failed' : 'complete',
    infrastructureBefore, infrastructureAfter, setupRetries, concurrentLanes: true, measurementLock: false, halves, joinErrors, joinTopics, readinessProbeDelivered,
    scope: browser ? 'Actual app browsers; current-week matchup score writes and resulting view refetches; no 12-game replay' : 'Realtime transport inventory; device-shaped subscriptions; no browser renders or game replay',
    latencyClock: 'One driver monotonic clock, write submission through receipt; includes docker exec startup',
    latencyScope: profile === 'idle' ? 'One out-of-window update after idle capture' : 'Writes inside the measured window',
    realtime: summarize(realtime), total: summarize(top), ...selectCosts(statements, minutes), walBytesPerMinute: (after.wal - before.wal) / minutes,
    walInsertBytesPerMinute: walInsertBytes / minutes, walFullPageImagesPerMinute: (after.walFpi - before.walFpi) / minutes,
    dbCpuSecondsPerMinute: (after.dbCpu - before.dbCpu) / 1e9 / minutes,
    realtimeCpuSecondsPerMinute: (after.realtimeCpu - before.realtimeCpu) / 1e9 / minutes,
    messages, wireMessages: browser ? wireMessages : null,
    decodedPayloadBytesPerMinute: bytes / minutes, p50Ms: quantile(0.5), p95Ms: quantile(0.95), missing,
    writes: events.length, writeIntervalMs, targetWrites: profile === 'idle' ? 0 : targetTicks, apiRequests, apiBytes, apiErrors, apiFailures, joins, disconnects, idleProbeDelivered, edgeRequests,
    liveGameId: liveGame?.id ?? null, fallbackPollMs: liveGame ? 20000 : null, versionRequests,
    socketBytesPerMinute: browser ? (socketBytesIn + socketBytesOut) / minutes : null,
    latencies, statements, realtimeStatements: realtime }
  await writeFile(file, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ...result, latencies: undefined, statements: undefined, realtimeStatements: undefined }))
  assert.equal(missing.length, 0, 'Every device must receive every hint')
  assert.equal(apiErrors, 0, 'App API requests must succeed')
  assert.equal(disconnects, 0, 'Capture browsers must stay connected')
  assert.equal(joinErrors, 0, 'Capture channels must stay authorized')
  assert.equal(infrastructureChanged, false, 'The private stack must not restart during a capture')
  assert.equal(fallbackMissing, false, 'Live home browsers must exercise the fallback version poll')
  assert.equal(missedWrites, false, 'The driver must complete every planned write')
} catch (error) {
  const saved = JSON.parse(await readFile(file, 'utf8'))
  if (saved.status === 'starting' || saved.status === 'capturing') {
    const detail = String(error.message).split('\n').filter(line => !/access_token|refresh_token|Authorization|apikey/i.test(line))
      .join('\n').replace(/eyJ[\w.-]+/g, '[redacted]').slice(0, 1200)
    await writeFile(file, JSON.stringify({ ...saved, status: 'failed', error: detail, infrastructureBefore, infrastructureAfter,
      apiErrors, apiFailures, disconnects, joins, joinErrors, joinTopics, joinedDevices: joined.size, messages, setupRetries }, null, 2), { mode: 0o600 })
  }
  throw error
} finally {
  await Promise.allSettled(clients.map(client => client.removeAllChannels()))
  await browser?.close()
  if (liveGame) await sql(`UPDATE public.nba_games game SET game_date=original.game_date,status=original.status,
    game_time=original.game_time,started_at=original.started_at
    FROM jsonb_populate_record(NULL::public.nba_games,'${JSON.stringify(liveGame).replaceAll("'", "''")}') original WHERE game.id=original.id`)
}
