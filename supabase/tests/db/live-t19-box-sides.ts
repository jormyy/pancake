import { strict as assert } from 'node:assert'

// The box side on every path that stores a box, and through a merge, up to the ESPN release sweep. The real
// cases are live-t19-box-paths.ts (the backfilled Clippers box, the merged split, the second silent move);
// here each condition is a case. P is on team T, ESPN last listed him there 48 hours ago and omits him now
// (a structurally complete 350-player listing), T played a game 20 hours ago that omits him, and a box of a
// game T did not play (home O, away V), 10 hours ago, lists him under V. The release must move him to V.
// - Paths: sync-stats (syncStatsGame), live-poll (syncLiveStatsGames, a live box), the CDN backfill (a cdn job,
//   one continuation of the served backfill handler) and the CDN enumeration backfill (a cdn-enum job over a
//   free synthetic season, its schedule row published). Each runs whole before the release, and again with
//   the release sent right after the path's first nba_cdn import of that game returns (the interleaving: a
//   side recorded after the box's own import leaves him cleared). Sync-stats also runs with a backfill of the
//   same game completing at that point. A refused box (an empty side) writes nothing on either backfill path,
//   and an enumerated game without a schedule row is stored with its sides.
// - Merge (merge_players, one rolled-back transaction per case): a merged-away row's game membership keeps its
//   side, a survivor's side is kept and a missing one filled, the ESPN listing moves to the survivor and the
//   later of two listings is kept; then the product's path: the NBA index step merges an ESPN row into the row
//   a box created, and the release moves the survivor to that box's side.
// --only=sync|backfill|merge runs one group (sync-stats and live-poll, the two backfill paths, the merges).
//
// Lane-bound: the stack must be this checkout's own (supabase/config.toml project and ports, loopback),
// and the shared or protected blocks 543xx, 572xx, 574xx, 577xx and 582xx are refused outright.
const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url))
const configured = (section: string) => config.match(new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
const project = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1]
const apiPort = configured('api'), dbPort = configured('db')
assert.ok(project && apiPort && dbPort, 'supabase/config.toml must declare project_id and api/db ports')
assert.equal(Deno.env.get('PANCAKE_TEST_PROJECT_ID'), project, 'PANCAKE_TEST_PROJECT_ID must name this checkout stack')
const refused = /^(543|572|574|577|582)\d\d$/
const api = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('API_URL')
const db = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DB_URL')
const key = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ?? Deno.env.get('SECRET_KEY')
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')
assert.ok(api && db && key && token, 'Set the local stack URLs, its secret key and PANCAKE_EDGE_INTERNAL_TOKEN')
for (const [value, port] of [[api, apiPort], [db, dbPort]]) {
  const target = new URL(value)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only a loopback stack is allowed')
  assert.equal(target.port, port, `Only this checkout's port ${port} is allowed`)
  assert.ok(!refused.test(target.port) && !refused.test(port), `Refuse the shared or protected block of port ${port}`)
}
Deno.env.set('SUPABASE_URL', api)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', key)
const originPort = Number(`${apiPort.slice(0, 3)}88`)

const q = (value: string) => `'${value.replaceAll("'", "''")}'`
async function psql(statement: string) {
  const child = new Deno.Command('psql', { args: [db!, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const result = await child.output()
  return { code: result.code, stdout: new TextDecoder().decode(result.stdout).trim(), stderr: new TextDecoder().decode(result.stderr).trim() }
}
async function sql(statement: string): Promise<string> {
  const result = await psql(statement)
  assert.equal(result.code, 0, result.stderr)
  return result.stdout
}
const log = (row: Record<string, unknown>) => console.log(JSON.stringify(row))
const only = Deno.args.find(arg => arg.startsWith('--only='))?.slice('--only='.length)
assert.ok(only === undefined || ['sync', 'backfill', 'merge'].includes(only), 'Pass --only= sync, backfill or merge, or nothing for every group')
const runs = (group: 'sync' | 'backfill' | 'merge') => only === undefined || only === group

const run = crypto.randomUUID().slice(0, 8)
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: the release reads every teamed player')
// Two free synthetic seasons: Y for stored games, E for the enumeration (its candidate ids are 002<E-2001>0NNNN).
const year = Number(await sql(`SELECT y FROM generate_series(23000,29998) y WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year IN (y,y+1))
  AND NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year IN (y,y+1))
  AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE job_type IN ('backfill_cdn_'||y,'backfill_cdn-enum_'||(y+1))) LIMIT 1`))
assert.ok(year)
const enumYear = year + 1
const enumGame = (n: number) => `002${String(enumYear - 2001).padStart(2, '0')}0${String(n).padStart(4, '0')}`
const etDate = (hours: number) => new Date(Date.now() + hours * 3_600_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const listing = Array.from({ length: 350 }, (_, index) => ({ provider_id: `t19s-${run}-l${index}`, first_name: 'Listed', last_name: `T19s${run}L${index}` }))
type Receipt = { released: string[]; held: { unproven: string[]; unclaimed: string[] } }
const release = async () => JSON.parse(await sql(`SELECT resolve_player_imports_atomic('espn_release',${q(JSON.stringify(listing))}::jsonb)::text`)) as Receipt

// The local origin serves this run's boxes; any other box is a 404 (an enumeration miss).
const statistics = Object.fromEntries(['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal', 'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points',
  'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal', 'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers'].map(stat => [stat, 1]))
const line = (personId: number, name: string) => ({ personId, name, played: '1', statistics: { ...statistics, minutes: 'PT10M00.00S' } })
const boxes = new Map<string, unknown>()
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const found = new URL(request.url).pathname.match(/^\/cdn\/liveData\/boxscore\/boxscore_(\w+)\.json$/)
  return found && boxes.has(found[1]) ? Response.json({ game: boxes.get(found[1]) }) : new Response('the local origin has no such route', { status: 404 })
})
const origin = `http://127.0.0.1:${originPort}`
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/cdn`)

// Every request stays on this stack, the origin or a handler. A hook may run once, right after the first
// nba_cdn import of its game returns, before the caller sees the response.
const workers: Deno.HttpServer<Deno.NetAddr>[] = []
let hook: { game: string; run: () => Promise<void>; after?: boolean } | null = null
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input)
  assert.ok([new URL(api).origin, origin, ...workers.map(worker => `http://127.0.0.1:${worker.addr.port}`)].includes(target.origin), `Refused request to ${target.origin}`)
  const response = await nativeFetch(input, init)
  if (hook && response.ok && target.pathname === '/rest/v1/rpc/resolve_player_imports_atomic' && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as { p_source: string; p_records: { nba_game_id?: string; nba_team?: unknown }[] }
    const records = body.p_source === 'nba_cdn' ? body.p_records.filter(record => record.nba_game_id === hook!.game) : []
    if (records.length > 0) {
      const armed = hook
      hook = null
      armed.after = records.some(record => 'nba_team' in record)
      await armed.run()
    }
  }
  return response
}
async function serve(load: () => Promise<unknown>) {
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!, nativeServe = Deno.serve
  let worker: Deno.HttpServer<Deno.NetAddr> | undefined
  Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => (worker = nativeServe({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler)) })
  try { await load() } finally { Object.defineProperty(Deno, 'serve', descriptor) }
  assert.ok(worker, 'The handler module must start one local server')
  workers.push(worker)
  return worker
}
async function invoke(worker: Deno.HttpServer<Deno.NetAddr>, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${worker.addr.port}`, { method: 'POST', headers: { 'x-internal-function-token': token!, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const jobs: string[] = []
const results: Record<string, unknown>[] = [], merges: Record<string, unknown>[] = []
try {
  const backfill = await serve(() => import('../../functions/backfill/index.ts'))
  const { syncStatsGame, syncLiveStatsGames } = await import('../../functions/_shared/syncStats.ts')
  const { createBackfillJob } = await import('../../functions/_shared/backfillJobs.ts')
  await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${enumYear},1,${q(etDate(-96))},${q(etDate(96))})`)

  type Path = 'sync-stats' | 'live-poll' | 'backfill cdn' | 'backfill cdn-enum'
  type BoxCase = { name: string; path: Path; during?: 'release' | 'backfill'; refused?: boolean; unscheduled?: boolean; expect: 'V' | 'held' }
  const paths: Path[] = ['sync-stats', 'live-poll', 'backfill cdn', 'backfill cdn-enum']
  const boxCases = ([
    ...paths.map((path): BoxCase => ({ name: `${path}: the box is stored, then the release`, path, expect: 'V' })),
    ...paths.map((path): BoxCase => ({ name: `${path}: the release right after the first import of the box`, path, during: 'release', expect: 'V' })),
    { name: 'sync-stats: a backfill of the same game completes, then the release, right after the first import of the box', path: 'sync-stats', during: 'backfill', expect: 'V' },
    { name: 'backfill cdn: a refused box (an empty side)', path: 'backfill cdn', refused: true, expect: 'held' },
    { name: 'backfill cdn-enum: a refused box (an empty side)', path: 'backfill cdn-enum', refused: true, expect: 'held' },
    { name: 'backfill cdn-enum: a game without a schedule row (no tipoff time, so not evidence)', path: 'backfill cdn-enum', unscheduled: true, expect: 'held' },
  ] satisfies BoxCase[] as BoxCase[]).filter(testCase => runs(testCase.path.startsWith('backfill') ? 'backfill' : 'sync'))
  const runBackfill = async (source: 'cdn' | 'cdn-enum') => {
    const job = await createBackfillJob(source, source === 'cdn' ? year : enumYear)
    jobs.push(job)
    const response = await invoke(backfill, { action: 'continue', jobId: job, offset: 0 })
    const attempts = JSON.parse(await sql(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',game_key,'status',status,'error',last_error) ORDER BY game_key),'[]')::text
      FROM backfill_game_attempts WHERE job_id=${q(job)} AND status<>'missing'`))
    return { job, status: response.status, body: response.body, attempts, missing: Number(await sql(`SELECT count(*) FROM backfill_game_attempts WHERE job_id=${q(job)} AND status='missing'`)) }
  }
  for (const [index, testCase] of boxCases.entries()) {
    const player = crypto.randomUUID(), team = `T${String(index).padStart(2, '0')}`, home = `O${index}`, away = `V${index}`, last = `T19s${run}P${index}`
    const person = 60_000_000 + Math.floor(Math.random() * 100_000) * 100 + index, other = person + 50
    const enumerated = testCase.path === 'backfill cdn-enum', live = testCase.path === 'live-poll'
    const seasonYear = enumerated ? enumYear : year, gameId = enumerated ? enumGame(1) : `002t19s${run}${index}`, id = crypto.randomUUID()
    boxes.clear()
    boxes.set(gameId, { gameId, gameStatus: live ? 2 : 3, gameStatusText: live ? 'Q2 5:00' : 'Final', gameEt: `${etDate(-10)}T19:00:00Z`, period: 2, gameClock: 'PT05M00.00S',
      homeTeam: { teamTricode: home, score: 100, players: testCase.refused ? [] : [line(other, `Synthetic ${last}O`)] },
      awayTeam: { teamTricode: away, score: 90, players: [line(person, `Synthetic ${last}`)] } })
    await sql(`INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id,nba_id)
        VALUES(${q(player)},'Synthetic',${q(last)},'PG',ARRAY['PG'],'Active',${q(team)},4,${q(`t19s-${run}-p${index}`)},${q(String(person))});
      INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at) VALUES(${q(player)},${q(team)},now()-interval '48 hours');
      INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
        VALUES(${q(`004t19s${run}${index}own`)},${seasonYear},1,${q(etDate(-20))},now()-interval '20 hours',${q(team)},${q(`R${index}`)},'Final',now());
      ${testCase.unscheduled ? '' : `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
        VALUES(${q(id)},${q(gameId)},${seasonYear},1,${q(etDate(-10))},now()-interval '10 hours',${q(home)},${q(away)},${q(enumerated ? 'Scheduled' : live ? 'InProgress' : 'Final')});`}`)
    const receipts: Receipt[] = []
    let detail: unknown = null
    const releaseNow = async () => { receipts.push(await release()) }
    const game = { id, nba_game_id: gameId, season_year: seasonYear, week_number: 1, status: live ? 'InProgress' : 'Final' }
    const armed = testCase.during ? { game: gameId, run: testCase.during === 'release' ? releaseNow
      : async () => { detail = { concurrentBackfill: await runBackfill('cdn') }; await releaseNow() }, after: undefined as boolean | undefined } : null
    hook = armed
    let stored: unknown
    if (testCase.path === 'sync-stats') stored = await syncStatsGame(game).then(lines => `stored ${lines}`, (error: Error) => `refused: ${error.message}`)
    else if (live) stored = await syncLiveStatsGames([game]).then(result => ({ statLines: result.statLines, failures: result.failures.map(String) }))
    else stored = await runBackfill(enumerated ? 'cdn-enum' : 'cdn')
    hook = null
    if (!testCase.during) await releaseNow()
    const state = JSON.parse(await sql(`SELECT json_build_object('team',(SELECT coalesce(nba_team,'none') FROM players WHERE id=${q(player)}),
      'sides',(SELECT coalesce(jsonb_agg(jsonb_build_array(p.nba_id,coalesce(m.nba_team,'-')) ORDER BY p.nba_id),'[]') FROM private.player_game_memberships m
        JOIN players p ON p.id=m.player_id JOIN nba_games g ON g.id=m.game_id WHERE g.nba_game_id=${q(gameId)}),
      'stats',(SELECT count(*) FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.nba_game_id=${q(gameId)}),
      'players',(SELECT count(*) FROM players))`)) as { team: string; sides: [string, string][]; stats: number; players: number }
    const receipt = receipts.at(-1)
    const released = receipt?.released.includes(player) ?? false, held = receipt ? [...receipt.held.unproven, ...receipt.held.unclaimed].includes(player) : false
    const outcome = !receipt ? 'no release ran' : released && held ? 'released and held' : released ? (state.team === team ? 'released, team kept' : state.team === away ? 'V' : state.team)
      : held ? (state.team === team ? 'held' : 'held, team changed') : 'not a candidate'
    results.push({ case: testCase.name, path: testCase.path, expect: testCase.expect, outcome, releases: receipts.length, releaseAfterSides: armed?.after ?? null,
      others: receipt ? [...receipt.released, ...receipt.held.unproven, ...receipt.held.unclaimed].filter(row => row !== player).length : 0, sides: state.sides,
      stats: state.stats, players: state.players, person, home, away, stored, detail })
    await sql(`DELETE FROM backfill_game_attempts WHERE job_id::text IN (${jobs.map(q).join(',') || 'NULL'});
      DELETE FROM player_game_stats WHERE game_id IN (SELECT id FROM nba_games WHERE season_year IN (${year},${enumYear}));
      DELETE FROM nba_games WHERE season_year IN (${year},${enumYear});
      DELETE FROM private.score_input_revisions WHERE scope LIKE ${q(`nba:${year}:%`)} OR scope LIKE ${q(`nba:${enumYear}:%`)} OR scope IN (${q(`calendar:${year}`)},${q(`calendar:${enumYear}`)})
        OR scope IN (SELECT 'player:'||id FROM players);
      DELETE FROM players;`)
  }

  // Merge cases. W is the surviving row (the box's: his NBA id), L the merged-away row (ESPN's). G is a game
  // T did not play; the memberships and listings each case names are written before merge_players(W, L).
  type MergeCase = { name: string; winner?: string | null; loser?: string | null; listings?: { winner?: [string, number]; loser?: [string, number] }; expect: { side?: string | null; listing?: [string, number] | null } }
  const mergeCases = ([
    { name: 'the merged-away row\'s side moves to the survivor', loser: 'V', expect: { side: 'V' } },
    { name: 'a survivor membership without a side takes the merged-away side', winner: null, loser: 'V', expect: { side: 'V' } },
    { name: 'the survivor\'s side stays when the merged-away membership has none', winner: 'V', loser: null, expect: { side: 'V' } },
    { name: 'the survivor\'s side stays when both have one', winner: 'V', loser: 'O', expect: { side: 'V' } },
    { name: 'the merged-away ESPN listing moves to the survivor', listings: { loser: ['T', 48] }, expect: { listing: ['T', 48] } },
    { name: 'the later listing is kept: the merged-away one', listings: { winner: ['A', 72], loser: ['T', 48] }, expect: { listing: ['T', 48] } },
    { name: 'the later listing is kept: the survivor\'s', listings: { winner: ['T', 24], loser: ['A', 48] }, expect: { listing: ['T', 24] } },
  ] satisfies MergeCase[] as MergeCase[]).filter(() => runs('merge'))
  const mergeSetup = (index: number, tag: string) => {
    const winner = crypto.randomUUID(), loser = crypto.randomUUID(), game = crypto.randomUUID(), person = String(70_000_000 + Math.floor(Math.random() * 100_000) * 100 + index)
    const setup = `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
        VALUES(${q(game)},${q(`002t19m${run}${tag}${index}`)},${year},1,${q(etDate(-10))},now()-interval '10 hours','O','V','Final',now()),
          (gen_random_uuid(),${q(`004t19m${run}${tag}${index}own`)},${year},1,${q(etDate(-20))},now()-interval '20 hours','T','R','Final',now());
      INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,nba_id)
        VALUES(${q(winner)},'Ben',${q(`T19m${run}${tag}${index}`)},NULL,'{}','Active',NULL,NULL,${q(person)});
      INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id)
        VALUES(${q(loser)},'Benjamin',${q(`T19m${run}${tag}${index}`)},'PG',ARRAY['PG'],'Active','T',4,${q(`t19m-${run}-${tag}${index}`)});`
    const state = `SELECT 'state:'||json_build_object('winner',(SELECT count(*) FROM players WHERE id=${q(winner)}),'loser',(SELECT count(*) FROM players WHERE id=${q(loser)}),
      'team',(SELECT nba_team FROM players WHERE id=${q(winner)}),
      'sides',(SELECT coalesce(jsonb_agg(coalesce(nba_team,'-')),'[]') FROM private.player_game_memberships WHERE player_id=${q(winner)} AND game_id=${q(game)}),
      'listing',(SELECT jsonb_build_array(nba_team,round(extract(epoch FROM now()-listed_at)/3600)) FROM private.player_espn_listings WHERE player_id=${q(winner)}))::text;`
    return { winner, loser, game, person, setup, state }
  }
  const stateOf = (stdout: string) => JSON.parse(stdout.split('\n').find(row => row.startsWith('state:'))!.slice(6)) as { winner: number; loser: number; team: string | null; sides: string[]; listing: [string, number] | null }
  for (const [index, testCase] of mergeCases.entries()) {
    const { winner, loser, game, setup, state } = mergeSetup(index, 'c')
    const membership = (id: string, side: string | null | undefined) => side === undefined ? ''
      : `INSERT INTO private.player_game_memberships(player_id,game_id,nba_team) VALUES(${q(id)},${q(game)},${side === null ? 'NULL' : q(side)});`
    const listingOf = (id: string, row?: [string, number]) => row ? `INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at) VALUES(${q(id)},${q(row[0])},now()-interval '${row[1]} hours');` : ''
    const result = await psql(`BEGIN; ${setup} ${membership(winner, testCase.winner)} ${membership(loser, testCase.loser)}
      ${listingOf(winner, testCase.listings?.winner)} ${listingOf(loser, testCase.listings?.loser)}
      SELECT merge_players(${q(winner)},${q(loser)}); ${state} ROLLBACK;`)
    const after = result.code === 0 ? stateOf(result.stdout) : null
    const got = { side: 'side' in testCase.expect ? (after?.sides.length === 1 ? after.sides[0] : after?.sides ?? null) : undefined,
      listing: 'listing' in testCase.expect ? after?.listing ?? null : undefined }
    merges.push({ case: testCase.name, code: result.code, error: result.code === 0 ? null : result.stderr.slice(-300), merged: after ? after.winner === 1 && after.loser === 0 : false,
      expect: testCase.expect, got: Object.fromEntries(Object.entries(got).filter(([, value]) => value !== undefined)) })
  }
  if (runs('merge')) {
    // The product's path: the ESPN row (no NBA id, ESPN's name) and the row the box created (his NBA id, the
    // box's name, no team, the box membership under V); the NBA index step names the ESPN row exactly.
    const { winner, loser, game, person, setup, state } = mergeSetup(0, 'p')
    const index = `SELECT 'index:'||resolve_player_imports_atomic('nba_index',jsonb_build_array(jsonb_build_object('player_id',${q(loser)}::text,'provider_id',${q(person)},
      'expected_display_name',(SELECT display_name FROM players WHERE id=${q(loser)}),'name_match','exact')))::text;`
    const result = await psql(`BEGIN; ${setup}
      INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at) VALUES(${q(loser)},'T',now()-interval '48 hours');
      INSERT INTO private.player_game_memberships(player_id,game_id,nba_team) VALUES(${q(winner)},${q(game)},'V');
      INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play) VALUES(${q(winner)},${q(game)},${year},1,${q(etDate(-10))},10,false);
      ${index} ${state}
      SELECT 'receipt:'||resolve_player_imports_atomic('espn_release',${q(JSON.stringify(listing))}::jsonb)::text;
      SELECT 'team:'||coalesce(nba_team,'none') FROM players WHERE id=${q(winner)};
      ROLLBACK;`)
    assert.equal(result.code, 0, result.stderr)
    const lines = result.stdout.split('\n'), value = (tag: string) => lines.find(row => row.startsWith(`${tag}:`))!.slice(tag.length + 1)
    const receipt = JSON.parse(value('receipt')) as Receipt, after = stateOf(result.stdout)
    merges.push({ case: 'the NBA index step merges the ESPN row into the box\'s row, then the release', code: 0, index: JSON.parse(value('index')), afterMerge: after,
      merged: after.winner === 1 && after.loser === 0, expect: { team: 'V', released: true, held: false, others: 0 }, got: { team: value('team'), released: receipt.released.includes(winner),
        held: [...receipt.held.unproven, ...receipt.held.unclaimed].includes(winner), others: [...receipt.released, ...receipt.held.unproven, ...receipt.held.unclaimed].filter(id => id !== winner).length } })
  }
} finally {
  try {
    hook = null
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    // The stack started with no players and both seasons free, so every one of these rows is this run's.
    await sql(`DELETE FROM backfill_game_attempts WHERE job_id::text IN (${jobs.map(q).join(',') || 'NULL'});
      DELETE FROM sync_jobs WHERE id::text IN (${jobs.map(q).join(',') || 'NULL'});
      DELETE FROM player_game_stats WHERE game_id IN (SELECT id FROM nba_games WHERE season_year IN (${year},${enumYear}));
      DELETE FROM nba_games WHERE season_year IN (${year},${enumYear});
      DELETE FROM season_weeks WHERE season_year IN (${year},${enumYear});
      DELETE FROM private.score_input_revisions WHERE scope LIKE ${q(`nba:${year}:%`)} OR scope LIKE ${q(`nba:${enumYear}:%`)} OR scope IN (${q(`calendar:${year}`)},${q(`calendar:${enumYear}`)})
        OR scope IN (SELECT 'player:'||id FROM players);
      DELETE FROM players;`)
  }
}

log({ provenance: 'SYNTHETIC', recipe: 'live-t19-box-sides', run, only: only ?? 'all', year, enumYear, results, merges,
  residue: JSON.parse(await sql(`SELECT json_build_object('players',(SELECT count(*) FROM players),'games',(SELECT count(*) FROM nba_games WHERE season_year IN (${year},${enumYear})),
    'memberships',(SELECT count(*) FROM private.player_game_memberships),'listings',(SELECT count(*) FROM private.player_espn_listings),
    'jobs',(SELECT count(*) FROM sync_jobs WHERE id::text IN (${jobs.map(q).join(',') || 'NULL'})))`)) })
const failed = results.filter(result => result.outcome !== result.expect).map(result => result.case)
const failedMerges = merges.filter(merge => merge.code !== 0 || !merge.merged || JSON.stringify(merge.got) !== JSON.stringify(merge.expect)).map(merge => merge.case)
assert.deepEqual(results.filter(result => result.others !== 0).map(result => result.case), [], 'Each release reads only its case\'s rows')
const refusedBox = (result: Record<string, unknown>) => String(result.case).includes('refused')
assert.deepEqual(results.filter(result => !refusedBox(result) && (result.stats !== 2 || result.players !== 2)).map(result => result.case), [],
  'Every box that is not refused stores both lines')
assert.deepEqual(results.filter(result => !refusedBox(result) && JSON.stringify(result.sides) !== JSON.stringify([[String(result.person), result.away], [String(Number(result.person) + 50), result.home]]))
  .map(result => result.case), [], 'Every stored box records each side')
assert.deepEqual(results.filter(result => refusedBox(result) && (result.stats !== 0 || result.players !== 1 || (result.sides as unknown[]).length !== 0)).map(result => result.case), [],
  'A refused box writes nothing')
assert.deepEqual(failed, [], 'On every path the release moves him to the side his box lists him under, or holds him without evidence')
assert.deepEqual(failedMerges, [], 'A merge keeps the box side and the latest ESPN listing, and the release after the product\'s merge moves him to the box side')
