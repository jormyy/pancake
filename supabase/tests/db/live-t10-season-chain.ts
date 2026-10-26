import { strict as assert } from 'node:assert'
import path from 'node:path'
import { virtualDate } from '../../../scripts/season-sim/virtual-clock.mjs'
import { Clock, Fixture, Transport, expectRows, q, rows, sql, type OutboxRow } from './notif-t9-support.ts'

// SYNTHETIC season worker chain. Production cron job commands dispatch through
// pg_net to the real served live-poll and season-boundary workers, which read a
// local fake NBA CDN, finalize the season, seed the final, roll the season over and
// complete the rookie draft. The production minute entry then finds the first
// scoring day, and the in-process process-trades worker delivers to fake Expo.
const recipe = 'supabase/tests/db/live-t10-season-chain.ts'
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(token)
const workerHost = Deno.env.get('E2E_INVOCATION_WORKER_HOST') ?? 'host.docker.internal'
assert.ok(['host.docker.internal', 'host.lima.internal'].includes(workerHost))
const evidence = Deno.env.get('LIVE_T10_EVIDENCE')
assert.ok(!evidence || (path.isAbsolute(evidence) && !evidence.startsWith(Deno.cwd() + '/')))

type Invocation = { id: string; function_name: string; worker_status: string | null; request_id: number | null; dispatch_job_key: string | null; invocation_key: string }
type Report = { leagueId: string; actions: string[]; error?: string }
type Matchup = { week: number; type: string; home: string; away: string; home_points: number; away_points: number; finalized: boolean; winner: string | null }

const NativeDate = Date
const jsClock = { simMs: NativeDate.now(), realMs: NativeDate.now(), rate: 1, capMs: null as number | null }
const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
const boxes = new Map<string, [number, number][][]>()
const providerRequests: string[] = []
const handlers = new Map<string, Deno.ServeHandler>()
const served: { fn: string; key: string | null; status: number; body: unknown }[] = []
const seen = new Set<string>()
const chain: Record<string, unknown>[] = []
let snapshot: { dispatch: unknown; lease: unknown; invocations: string[]; runs: string[]; responses: number[] } | undefined
let router: Deno.HttpServer<Deno.NetAddr> | undefined

const provider = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
  const pathname = new URL(request.url).pathname
  providerRequests.push(pathname)
  const id = pathname.match(/^\/static\/json\/liveData\/boxscore\/boxscore_(\d{10})\.json$/)?.[1]
  const box = id ? boxes.get(id) : undefined
  if (!id || !box) return new Response('Unexpected local provider request', { status: 404 })
  const player = ([personId, points]: [number, number]) => ({ personId, name: `Chain P${personId}`, played: '1', statistics: {
    minutes: 'PT30M00.00S', points, reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0, assists: 0, steals: 0, blocks: 0,
    turnovers: 0, foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0, threePointersMade: 0, threePointersAttempted: 0,
    freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0,
  } })
  return Response.json({ game: { gameId: id, gameStatus: 3, period: 4, gameClock: 'PT00M00.00S', gameEt: null,
    homeTeam: { teamTricode: 'BOS', players: box[0].map(player) }, awayTeam: { teamTricode: 'NYK', players: box[1].map(player) } } })
})
transport.aux.push(provider)
Deno.env.set('NBA_CDN_BASE_URL', `http://127.0.0.1:${provider.addr.port}/static/json`)

async function at(instant: string) {
  await clock.at(instant)
  Object.assign(jsClock, { simMs: NativeDate.parse(instant), realMs: NativeDate.now() })
}
async function scan(instant: string) {
  await at(instant)
  await sql(clock.minute)
}
const invocations = async () => JSON.parse(await sql(`SELECT COALESCE(json_agg(json_build_object('id',id::text,'function_name',function_name,
  'worker_status',worker_status,'request_id',request_id,'dispatch_job_key',dispatch_job_key,'invocation_key',invocation_key::text)),'[]') FROM edge_invocations`)) as Invocation[]

// Runs the job command exactly as pg_cron stores it, with the Edge base URL and
// internal token pg_net uses, and follows the one dispatch to its worker outcome.
async function cron(job: string, expected: string | null) {
  const command = clock.jobs.find(entry => entry.jobname === job)?.command
  assert.ok(command, `${job} is a scheduled production job (${clock.jobs.map(entry => entry.jobname)})`)
  for (const row of await invocations()) seen.add(row.id)
  await sql(`SELECT set_config('app.supabase_url',${q(`http://${workerHost}:${router!.addr.port}`)},false),set_config('app.edge_internal_token',${q(token)},false); ${command}`)
  const created = (await invocations()).filter(row => !seen.has(row.id))
  created.forEach(row => seen.add(row.id))
  if (!expected) {
    assert.deepEqual(created.map(row => row.function_name), [], `${job}: no Edge dispatch`)
    chain.push({ job, at: new Date().toISOString(), dispatched: null })
    return null
  }
  assert.deepEqual(created.map(row => row.function_name), [expected], `${job}: cron dispatches exactly one ${expected}`)
  const deadline = performance.now() + 120_000
  for (;;) {
    const invocation = (await invocations()).find(row => row.id === created[0].id)!
    const response = JSON.parse(await sql(`SELECT COALESCE((SELECT json_build_object('status_code',status_code,'timed_out',timed_out,'error_msg',error_msg)
      FROM net._http_response WHERE id=${invocation.request_id}),'null')`)) as { status_code: number | null; timed_out: boolean | null; error_msg: string | null } | null
    const worker = served.find(row => row.key === invocation.invocation_key)
    if (response && worker && ['success', 'failed'].includes(invocation.worker_status ?? '')) {
      assert.deepEqual([invocation.worker_status, worker.status, response.status_code], ['success', 200, 200], `${expected}: ${JSON.stringify({ invocation, response, worker })}`)
      if (job === 'season-boundary') assert.equal(invocation.dispatch_job_key, 'season-boundary')
      chain.push({ job, at: new Date().toISOString(), dispatched: expected, invocation: invocation.invocation_key, worker: invocation.worker_status, http: response.status_code })
      return worker.body as { ok: boolean; leagues?: Report[] }
    }
    assert.ok(performance.now() < deadline, `${expected}: pg_net reaches the served worker (${JSON.stringify({ invocation, response, worker })})`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
const report = (body: { leagues?: Report[] } | null, league: string) => body?.leagues?.find(row => row.leagueId === league)
const matchups = async (season: string) => JSON.parse(await sql(`SELECT COALESCE(json_agg(json_build_object('week',week_number,'type',matchup_type,'home',home_member_id,'away',away_member_id,
  'home_points',home_points,'away_points',away_points,'finalized',is_finalized,'winner',winner_member_id) ORDER BY week_number,matchup_type,home_member_id),'[]')
  FROM matchups WHERE league_season_id=${q(season)} AND NOT is_voided`)) as Matchup[]
const scope = (season: string) => `data->>'leagueSeasonId'=${q(season)}`

async function proveChain(batch: OutboxRow[], label: string) {
  const nativeLog = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string') lines.push(args[0])
    nativeLog(...args)
  }
  try {
    await transport.prove(fixture, batch, label)
  } finally {
    console.log = nativeLog
  }
  const observation = lines.flatMap(line => line.startsWith('{') ? [JSON.parse(line)] : []).find(row => row.test === label)
  assert.ok(observation, `${label}: proof observation`)
  const row = { ...observation, path: 'edge-http + cron', provenance: 'SYNTHETIC', chain: chain.map(step => ({ ...step })) }
  console.log(JSON.stringify(row))
  if (evidence) await Deno.writeTextFile(path.join(evidence, 'proof-observations.jsonl'), JSON.stringify(row) + '\n', { append: true })
}

try {
  await clock.start('2026-10-19T16:00:00Z')
  Object.assign(jsClock, { simMs: NativeDate.parse('2026-10-19T16:00:00Z'), realMs: NativeDate.now() })
  globalThis.Date = virtualDate(NativeDate, () => jsClock)
  snapshot = JSON.parse(await sql(`SELECT json_build_object(
    'dispatch',(SELECT row_to_json(d) FROM cron_dispatch_state d WHERE job_key='season-boundary'),
    'lease',(SELECT row_to_json(l) FROM live_poll_leases l WHERE lock_key=779001),
    'invocations',(SELECT COALESCE(json_agg(id::text),'[]') FROM edge_invocations),
    'runs',(SELECT COALESCE(json_agg(id::text),'[]') FROM sync_runs),
    'responses',(SELECT COALESCE(json_agg(id),'[]') FROM net._http_response))`))
  await fixture.init()
  await transport.start()
  router = Deno.serve({ hostname: workerHost === 'host.docker.internal' ? '0.0.0.0' : '127.0.0.1', port: 0, onListen() {} }, async (request, info) => {
    const fn = new URL(request.url).pathname.match(/^\/functions\/v1\/([a-z-]+)$/)?.[1]
    const handler = fn ? handlers.get(fn) : undefined
    if (!fn || !handler) return new Response('Unknown local function', { status: 404 })
    const response = await handler(request, info)
    const text = await response.clone().text()
    served.push({ fn, key: request.headers.get('x-pancake-invocation-id'), status: response.status, body: text.startsWith('{') ? JSON.parse(text) : text })
    return response
  })
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
  for (const [name, load] of [
    ['live-poll', () => import('../../functions/live-poll/index.ts')],
    ['season-boundary', () => import('../../functions/season-boundary/index.ts')],
  ] as const) {
    Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => { handlers.set(name, handler) } })
    try { await load() } finally { Object.defineProperty(Deno, 'serve', descriptor) }
    assert.ok(handlers.has(name), `${name} registers its served handler`)
  }

  const league = await fixture.league('active', 0, true, 2)
  const [A, B, C, D] = league.members
  const nextYear = league.year + 1
  fixture.years.push(nextYear)
  assert.equal(await sql(`SELECT count(*) FROM season_weeks WHERE season_year=${nextYear}`), '0', 'The rollover year is free')
  const base = 700000000 + crypto.getRandomValues(new Uint32Array(1))[0] % 200000000
  const personIds = league.members.map((_, index) => base + index)
  const veterans = league.members.map(() => crypto.randomUUID())
  fixture.players.push(...veterans)
  await sql(`UPDATE leagues SET scoring_settings='{"points":1}'::jsonb WHERE id=${q(league.id)};
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT ${nextYear},w,date '2026-11-09'+(w-1)*7,date '2026-11-15'+(w-1)*7 FROM generate_series(1,24) w;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,nba_id)
      VALUES ${veterans.map((id, index) => `(${q(id)},'Chain',${q(`P${personIds[index]}`)},'PG',ARRAY['PG'],'Active',${q(index < 2 ? 'BOS' : 'NYK')},5,${q(String(personIds[index]))})`).join(',')};
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
      SELECT ${q(league.id)},${q(league.season)},member,player,'draft','2026-10-18T12:00:00Z' FROM unnest(ARRAY[${league.members.map(q)}]::uuid[],ARRAY[${veterans.map(q)}]::uuid[]) u(member,player);
    INSERT INTO weekly_lineups(player_id,league_id,league_season_id,member_id,week_number,game_date,slot_type,is_auto_set)
      SELECT player,${q(league.id)},${q(league.season)},member,week,day::date,'PG',false
      FROM unnest(ARRAY[${league.members.map(q)}]::uuid[],ARRAY[${veterans.map(q)}]::uuid[]) u(member,player) CROSS JOIN (VALUES (1,'2026-10-25'),(2,'2026-11-01')) d(week,day);
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,home_points,away_points)
      VALUES (${q(league.id)},${q(league.season)},1,${q(A)},${q(D)},'regular_season',0,0),(${q(league.id)},${q(league.season)},1,${q(B)},${q(C)},'regular_season',0,0);`)
  for (let pick = 0; pick < 12; pick++) await fixture.player()
  const weekOneGame = await fixture.game(league.year, '2026-10-25', 1)
  const finalGame = await fixture.game(league.year, '2026-11-01', 2)
  await fixture.game(nextYear, '2026-11-09', 1, '001')
  await fixture.game(nextYear, '2026-11-10', 1)
  const providerId = (game: string) => sql(`SELECT nba_game_id FROM nba_games WHERE id=${q(game)}`)
  boxes.set(await providerId(weekOneGame), [[[personIds[0], 40], [personIds[1], 30]], [[personIds[2], 20], [personIds[3], 10]]])
  boxes.set(await providerId(finalGame), [[[personIds[0], 5], [personIds[1], 50]], [[personIds[2], 45], [personIds[3], 1]]])
  assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE game_date BETWEEN '2026-10-24' AND '2026-11-11' AND id NOT IN (${fixture.games.map(q)})`), '0',
    'No other local games share the simulated window')
  // The live poller already stored a provisional final box; the provider later corrects it.
  const provisionalFinal = (game: string, week: number) => sql(`UPDATE nba_games SET status='Final',game_status_text='Final',stats_synced_at=now() WHERE id=${q(game)};
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play)
      SELECT player,${q(game)},${league.year},${week},1,false FROM unnest(ARRAY[${veterans.map(q)}]::uuid[]) player;`)

  // Week 1 closes: overdue final stats dispatch the live-poll repair worker.
  await at('2026-10-26T04:00:00Z')
  await provisionalFinal(weekOneGame, 1)
  await at('2026-10-26T14:00:00Z')
  assert.equal((await cron('nba-live-poll', 'live-poll'))?.ok, true)
  assert.ok(providerRequests.includes(`/static/json/liveData/boxscore/boxscore_${await providerId(weekOneGame)}.json`), 'The served worker re-reads the corrected final box')
  assert.deepEqual((await matchups(league.season)).map(row => [row.home, row.home_points, row.away, row.away_points, row.finalized, row.winner]),
    [[A, 40, D, 10, true, A], [B, 30, C, 20, true, B]], 'Corrected provider stats finalize week 1')

  // The first date after the last game stays inside the correction window.
  await at('2026-10-26T16:00:00Z')
  assert.deepEqual(report(await cron('season-boundary', 'season-boundary'), league.id), { leagueId: league.id, actions: [] })
  await at('2026-10-27T16:00:00Z')
  assert.deepEqual(report(await cron('season-boundary', 'season-boundary'), league.id), { leagueId: league.id, actions: ['bracket-generated'] })
  assert.deepEqual((await matchups(league.season)).filter(row => row.type === 'playoff_final').map(row => [row.week, row.home, row.away]), [[2, A, B]])
  assert.equal(await sql(`SELECT status FROM leagues WHERE id=${q(league.id)}`), 'playoffs')

  // The final closes and the next recovery dispatch finalizes it from corrected stats.
  await at('2026-11-02T04:00:00Z')
  await provisionalFinal(finalGame, 2)
  await at('2026-11-02T15:00:00Z')
  assert.equal((await cron('nba-live-poll', 'live-poll'))?.ok, true)
  assert.deepEqual((await matchups(league.season)).filter(row => row.type === 'playoff_final').map(row => [row.home_points, row.away_points, row.finalized, row.winner]),
    [[5, 50, true, B]], 'Corrected provider stats decide the final')

  // Rollover waits 48 hours after the final.
  await at('2026-11-03T16:00:00Z')
  assert.deepEqual(report(await cron('season-boundary', 'season-boundary'), league.id), { leagueId: league.id, actions: [] })
  assert.equal(await sql(`SELECT count(*) FROM league_seasons WHERE league_id=${q(league.id)}`), '1')
  assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='season_rollover' AND member_id IN (${league.members.map(q)})`), '0')
  await at('2026-11-04T16:00:00Z')
  assert.deepEqual(report(await cron('season-boundary', 'season-boundary'), league.id), { leagueId: league.id, actions: ['season-advanced', 'matchups-generated'] })
  const next = JSON.parse(await sql(`SELECT json_build_object('id',id,'year',season_year) FROM league_seasons WHERE league_id=${q(league.id)} AND is_current`)) as { id: string; year: number }
  assert.equal(next.year, nextYear)
  assert.equal(await sql(`SELECT status FROM leagues WHERE id=${q(league.id)}`), 'offseason')
  assert.equal((await matchups(next.id)).filter(row => row.week === 1 && row.type === 'regular_season').length, 2, 'The rolled season is scheduled')
  const rolled = await expectRows('season_rollover', scope(next.id), league.members, async () => {
    await at('2026-11-04T16:30:00Z')
    assert.equal(await cron('season-boundary', null), null, 'The same ET day cannot dispatch the boundary worker twice')
    await at('2026-11-05T16:00:00Z')
    assert.deepEqual(report(await cron('season-boundary', 'season-boundary'), league.id), { leagueId: league.id, actions: [] }, 'A repeated worker run is a no-op before opening night')
  })
  await scan('2026-11-05T16:05:00Z')
  assert.equal((await rows('season_started', scope(next.id))).length, 0, 'An offseason league has not started')
  await proveChain(rolled, `${recipe}#season_rollover`)

  // Opening night: the boundary backstop drafts rookies and activates the league; the minute entry starts the season.
  await scan('2026-11-09T16:00:00Z')
  assert.equal((await rows('season_started', scope(next.id))).length, 0, 'An exhibition-only day is not the first scoring day')
  await at('2026-11-10T13:30:00Z')
  assert.equal(await cron('season-boundary', null), null, 'The boundary job is due from 09:00 ET')
  await scan('2026-11-10T13:31:00Z')
  assert.equal((await rows('season_started', scope(next.id))).length, 0, 'The first scoring day cannot start a league that is still offseason')
  await at('2026-11-10T14:30:00Z')
  assert.deepEqual(report(await cron('season-boundary', 'season-boundary'), league.id), { leagueId: league.id, actions: ['rookie-draft-started', 'rookie-draft-auto-completed'] })
  assert.equal(await sql(`SELECT status FROM leagues WHERE id=${q(league.id)}`), 'active')
  assert.equal(await sql(`SELECT count(*) FROM snake_draft_picks pick JOIN drafts draft ON draft.id=pick.draft_id WHERE draft.league_id=${q(league.id)} AND pick.player_id IS NOT NULL`), '12')
  assert.equal((await rows('season_started', scope(next.id))).length, 0, 'Only the minute scanner starts a season')
  await scan('2026-11-10T14:40:00Z')
  const started = await expectRows('season_started', scope(next.id), league.members, () => scan('2026-11-10T14:41:00Z'))
  await proveChain(started, `${recipe}#season_started`)
  await scan('2026-11-11T16:00:00Z')
  assert.equal((await rows('season_started', scope(next.id))).length, 4, 'The next day cannot repeat the start')
  assert.equal((await rows('season_rollover', scope(next.id))).length, 4)
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe, path: 'edge-http + cron', steps: chain.length, providerRequests: providerRequests.length,
    served: served.map(row => `${row.fn}:${row.status}`) }))
} finally {
  globalThis.Date = NativeDate
  await transport.close()
  await router?.shutdown()
  if (fixture.games.length) await sql(`DELETE FROM player_game_stats WHERE game_id IN (${fixture.games.map(q)})`)
  await fixture.cleanup()
  if (snapshot) {
    await sql(`DELETE FROM net._http_response WHERE NOT (id = ANY(ARRAY[${snapshot.responses}]::bigint[]));
      DELETE FROM edge_invocations WHERE NOT (id::text = ANY(ARRAY[${snapshot.invocations.map(q)}]::text[]));
      DELETE FROM sync_runs WHERE NOT (id::text = ANY(ARRAY[${snapshot.runs.map(q)}]::text[]));
      DELETE FROM cron_dispatch_state WHERE job_key='season-boundary';
      INSERT INTO cron_dispatch_state SELECT * FROM json_populate_record(NULL::cron_dispatch_state, ${q(JSON.stringify(snapshot.dispatch))}::json) WHERE ${snapshot.dispatch ? 'true' : 'false'};
      DELETE FROM live_poll_leases WHERE lock_key=779001;
      INSERT INTO live_poll_leases SELECT * FROM json_populate_record(NULL::live_poll_leases, ${q(JSON.stringify(snapshot.lease))}::json) WHERE ${snapshot.lease ? 'true' : 'false'};`)
  }
  await clock.restore()
}
