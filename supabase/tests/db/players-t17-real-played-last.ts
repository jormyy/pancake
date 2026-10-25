import { strict as assert } from 'node:assert'

// A box omission is not proof that a player left, even when his last listing shows him playing.
// Through the real sync-stats (syncStatsGame) and sync-players code against a served origin whose NBA CDN
// boxes are twelve real final boxes, byte for byte (players-t17-real-boxes/README.md), and whose ESPN
// listing is synthetic and complete (every part 200, 30 teams, more than 350 athletes, no import failure):
// - Banton (BOS) plays in BOS's box of 2026-02-27 and BOS's box of 2026-03-01 omits him (ESPN's own summary
//   of that game lists him for BOS); BOS's box of 2026-04-12 lists him playing.
// - Bradley (IND, 2026-01-04 / 01-06 / 01-08), Conley (MIN, 2026-02-02 / 02-04 / 02-20) and Bagley (PHI,
//   2025-04-01 / 04-03 / 04-05): the same, each playing in his first box and listed again by his team.
// No box lists any of them for another team in between: each stayed on his team. The complete refresh that
// omits all four holds every team and reports each as unproven; his row, ids, injury and status, ownership
// and lineups stay; his return box scores for his fantasy team. The real dates are kept in the observations. The stored schedule puts each first box two days
// back, each second box after ESPN's listing and each third box after the refresh, the order a release would
// compare with ESPN's listing time on this clock. The third boxes go on days of their own in real date order,
// and each player is started only on his own return box's day: Bagley's return box (PHI against MIN,
// 2025-04-05) also lists Conley playing for MIN, a real row of that game that scores on that game's day, where
// he is not started. Conley's own return (MIN against DAL, 2026-02-20) lists him DNP and scores nothing.
//
// Lane-bound: the stack must be this checkout's own (supabase/config.toml project and ports, loopback),
// and the shared or protected blocks 543xx, 572xx, 574xx and 582xx are refused outright.
const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url))
const configured = (section: string) => config.match(new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
const project = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1]
const apiPort = configured('api'), dbPort = configured('db')
assert.ok(project && apiPort && dbPort, 'supabase/config.toml must declare project_id and api/db ports')
assert.equal(Deno.env.get('PANCAKE_TEST_PROJECT_ID'), project, 'PANCAKE_TEST_PROJECT_ID must name this checkout stack')
const refused = /^(543|572|574|582)\d\d$/
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
const originPort = Number(`${apiPort.slice(0, 3)}85`)

const q = (value: string) => `'${value.replaceAll("'", "''")}'`
async function sql(statement: string): Promise<string> {
  const child = new Deno.Command('psql', { args: [db!, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const result = await child.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const json = async <T>(statement: string): Promise<T> => JSON.parse(await sql(statement))

// The twelve real boxes, checked against their pinned SHA-256 and served unchanged.
type BoxPlayer = { personId: number; status: string; played: string; statistics: { points: number; reboundsTotal: number; assists: number } }
type BoxTeam = { teamTricode: string; score: number; players: BoxPlayer[] }
type RealBox = { body: Uint8Array; game: { gameId: string; gameEt: string; gameStatus: number; homeTeam: BoxTeam; awayTeam: BoxTeam } }
const fixtures = new URL('./players-t17-real-boxes/', import.meta.url)
const realBoxes = new Map<string, RealBox>()
for await (const entry of Deno.readDir(fixtures)) {
  const pinned = entry.name.match(/^boxscore-(\d{10})-([0-9a-f]{64})\.json\.gz$/)
  if (!pinned) continue
  const file = await Deno.open(new URL(entry.name, fixtures))
  const body = new Uint8Array(await new Response(file.readable.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), byte => byte.toString(16).padStart(2, '0')).join('')
  assert.equal(digest, pinned[2], `${entry.name}: the body must match its pinned SHA-256`)
  const { game } = JSON.parse(new TextDecoder().decode(body)) as Pick<RealBox, 'game'>
  assert.equal(game.gameId, pinned[1])
  assert.equal(game.gameStatus, 3, `${pinned[1]} is a final box`)
  realBoxes.set(pinned[1], { body, game })
}
assert.equal(realBoxes.size, 12, 'All twelve pinned boxes are present')
const listedIn = (gameId: string, person: number) => {
  const { homeTeam, awayTeam } = realBoxes.get(gameId)!.game
  for (const team of [homeTeam, awayTeam]) {
    const row = team.players.find(player => player.personId === person)
    if (row) return { team: team.teamTricode, status: row.status, played: row.played, points: row.statistics.points, rebounds: row.statistics.reboundsTotal, assists: row.statistics.assists }
  }
  return null
}

// Each real player: his three boxes (played, omitted, listed again by the same team).
type Real = { label: string; person: number; first: string; last: string; team: string; boxes: [string, string, string] }
const banton: Real = { label: 'Banton', person: 1630625, first: 'Dalano', last: 'Banton', team: 'BOS', boxes: ['0022500859', '0022500874', '0022501186'] }
const bradley: Real = { label: 'Bradley', person: 1628396, first: 'Tony', last: 'Bradley', team: 'IND', boxes: ['0022500495', '0022500510', '0022500528'] }
const conley: Real = { label: 'Conley', person: 201144, first: 'Mike', last: 'Conley', team: 'MIN', boxes: ['0022500714', '0022500727', '0022500806'] }
const bagley: Real = { label: 'Bagley', person: 1630542, first: 'Marcus', last: 'Bagley', team: 'PHI', boxes: ['0022401098', '0022401115', '0022401130'] }
const reals = [banton, bradley, conley, bagley]
for (const real of reals) {
  const [first, omitted, again] = real.boxes.map(gameId => listedIn(gameId, real.person))
  assert.deepEqual([first?.team, first?.played], [real.team, '1'], `${real.label}: his first box lists him playing for ${real.team}`)
  assert.equal(omitted, null, `${real.label}: his team's next box omits him`)
  assert.ok([realBoxes.get(real.boxes[1])!.game.homeTeam.teamTricode, realBoxes.get(real.boxes[1])!.game.awayTeam.teamTricode].includes(real.team))
  assert.equal(again?.team, real.team, `${real.label}: ${real.team}'s third box lists him again`)
}

// The served ESPN origin: 30 teams of 17 synthetic athletes plus the real players ESPN lists in a refresh.
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const run = crypto.randomUUID().slice(0, 8)
type Athlete = { espn: string; first: string; last: string; team: string }
const fillers: Athlete[] = codes.flatMap((team, index) => Array.from({ length: 17 }, (_, slot) => ({ espn: `t17-${run}-${index}-${slot}`, first: 'Synthetic', last: `T17${run}t${index}s${slot}`, team })))
const espnOf = (real: Real): Athlete => ({ espn: `t17-${run}-${real.label.toLowerCase()}`, first: real.first, last: real.last, team: real.team })

let feed: Athlete[] = []
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), box = route.match(/^\/cdn\/liveData\/boxscore\/boxscore_(.+)\.json$/)
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map(abbreviation => ({ team: { id: String(codes.indexOf(abbreviation) + 1), abbreviation } })) }] }] })
  if (roster) {
    const team = codes[Number(roster[1]) - 1]
    return Response.json({ athletes: feed.filter(listed => listed.team === team).map(listed => ({ id: listed.espn, firstName: listed.first, lastName: listed.last,
      fullName: `${listed.first} ${listed.last}`, position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 4 } })) })
  }
  if (route === '/site/injuries') return Response.json({ injuries: [] })
  if (route === '/site/news') return Response.json({ articles: [] })
  if (route === '/cdn/staticData/playerIndex.json') return Response.json({ resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: [] }] })
  if (box && realBoxes.has(box[1])) return new Response(realBoxes.get(box[1])!.body.slice(), { headers: { 'content-type': 'application/json' } })
  if (route.startsWith('/career/')) return Response.json({})
  return new Response('served origin has no such route', { status: 404 })
})
const origin = `http://127.0.0.1:${originPort}`
Deno.env.set('PLAYER_SYNC_SOURCE', 'espn')
Deno.env.set('ESPN_SITE_BASE_URL', `${origin}/site`)
Deno.env.set('ESPN_CAREER_BASE_URL', `${origin}/career`)
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/cdn`)
Deno.env.set('SLEEPER_BASE_URL', `${origin}/sleeper`)

// The handlers run in this process; every request must stay on this stack, the origin or a handler.
const workers: Deno.HttpServer<Deno.NetAddr>[] = []
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input)
  assert.ok([new URL(api).origin, origin, ...workers.map(worker => `http://127.0.0.1:${worker.addr.port}`)].includes(target.origin), `Refused request to ${target.origin}`)
  return nativeFetch(input, init)
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
async function invoke(worker: Deno.HttpServer<Deno.NetAddr>, body: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${worker.addr.port}`, { method: 'POST', headers: { 'x-internal-function-token': token!, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const etDate = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const pastDay = etDate(-2)
const user = crypto.randomUUID(), league = crypto.randomUUID(), season = crypto.randomUUID(), member = crypto.randomUUID()
const games: string[] = []
const people = [...new Set([...realBoxes.values()].flatMap(({ game }) => [...game.homeTeam.players, ...game.awayTeam.players].map(player => String(player.personId))))]
const started = new Date().toISOString()
const scoring = { points: 1, rebounds: 1, assists: 1 }
let year = 0
const identity = (person: number) => json<Record<string, unknown> | null>(`SELECT coalesce((SELECT to_jsonb(p) FROM (SELECT id,espn_id,nba_id,sleeper_id,first_name,last_name,
  display_name,position,eligible_positions,status,injury_status,years_exp,nba_draft_number,nba_team FROM players WHERE nba_id=${q(String(person))}) p),'null')`)
const rowsFor = (person: number) => sql(`SELECT count(*) FROM players WHERE nba_id=${q(String(person))}`)
const ownership = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE player_id=${q(id)}`)
const lineups = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.game_date,l.slot_type),'[]') FROM weekly_lineups l WHERE player_id=${q(id)}`)
const boxRows = (id: string) => json<{ game: string; game_date: string; did_not_play: boolean; member: boolean }[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,
  'game_date',s.game_date,'did_not_play',s.did_not_play,'member',EXISTS(SELECT 1 FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id))
  ORDER BY g.game_date,g.game_time),'[]') FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE s.player_id=${q(id)}`)
const observations: Record<string, unknown>[] = []
try {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: a refresh may release any teamed player it does not list')
  assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE nba_game_id IN (${[...realBoxes.keys()].map(q)})`), '0', 'The real game ids must be free on this stack')
  year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
  assert.ok(year)
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${q(user)},${q(user + '@example.test')},jsonb_build_object('username',${q(user)}));
    INSERT INTO leagues(id,slug,name,commissioner_id,status) VALUES(${q(league)},${q('t17-played-last-' + run)},'Synthetic played last',${q(user)},'active');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(user)},'commissioner','Played last');
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,${q(etDate(-3))},${q(etDate(3))});`)
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
  const { calcWeekPointsByMember } = await import('../../functions/_shared/scoreLineups.ts')
  const refresh = async (label: string, athletes: Athlete[]) => {
    feed = athletes
    const response = await invoke(sync)
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.ok, true, `${label}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  // One real final box, stored through the real CDN box import on the stored schedule's date and tip-off.
  const stored: string[] = []
  const storeBox = async (gameId: string, day: number, tipoff: string) => {
    const { game } = realBoxes.get(gameId)!
    const id = crypto.randomUUID()
    games.push(id)
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
      VALUES(${q(id)},${q(gameId)},${year},1,${q(etDate(day))},${tipoff},${q(game.homeTeam.teamTricode)},${q(game.awayTeam.teamTricode)},'Final',
        ${game.homeTeam.score},${game.awayTeam.score},'Final')`)
    const lines = await syncStatsGame({ id, nba_game_id: gameId, season_year: year, week_number: 1, status: 'Final',
      home_score: game.homeTeam.score, away_score: game.awayTeam.score, game_status_text: 'Final' })
    assert.equal(lines, game.homeTeam.players.length + game.awayTeam.players.length, `${gameId}: every player the real box lists is stored`)
    assert.equal(await sql(`SELECT stats_synced_at IS NOT NULL FROM nba_games WHERE id=${q(id)}`), 't', `${gameId}: the complete final box is stored`)
    stored.push(gameId)
  }
  const realDates = Object.fromEntries(reals.map(real => [real.label, real.boxes.map(gameId => ({ game: gameId, date: realBoxes.get(gameId)!.game.gameEt.slice(0, 10), lists: listedIn(gameId, real.person) }))]))

  // Each player's first real box, two days back: the CDN import creates his row (nba_id, names) and his box row.
  for (const real of reals) await storeBox(real.boxes[0], -2, "now()-interval '2 days'")
  const ids: Record<string, string> = {}
  for (const real of reals) {
    const row = await identity(real.person)
    assert.ok(row, `${real.label}: the CDN import created his row`)
    ids[real.label] = String(row.id)
  }
  await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      SELECT ${q(league)},${q(season)},${q(member)},id,'draft' FROM unnest(ARRAY[${reals.map(real => q(ids[real.label]))}]::uuid[]) id;
    INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
      SELECT ${q(member)},${q(league)},${q(season)},id,1,${q(pastDay)},'BE',false,now() FROM unnest(ARRAY[${reals.map(real => q(ids[real.label]))}]::uuid[]) id;`)

  // Refresh 1 lists all four on their teams and claims each CDN row by name.
  await refresh('refresh 1', [...fillers, ...reals.map(espnOf)])
  const before: Record<string, Record<string, unknown>> = {}
  for (const real of reals) {
    assert.equal(await rowsFor(real.person), '1', `${real.label}: one row carries his NBA id`)
    const row = (await identity(real.person))!
    assert.deepEqual({ id: row.id, espn: row.espn_id, team: row.nba_team }, { id: ids[real.label], espn: `t17-${run}-${real.label.toLowerCase()}`, team: real.team },
      `${real.label}: ESPN claimed the CDN row and teamed it`)
    before[real.label] = row
  }
  const owned = Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await ownership(ids[real.label])])))
  const lined = Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await lineups(ids[real.label])])))

  // Each team's next real box, played after that listing, omits him; his last stored listing shows him playing.
  for (const real of reals) await storeBox(real.boxes[1], 0, 'clock_timestamp()')
  for (const real of reals) {
    const rows = await boxRows(ids[real.label])
    assert.ok(!rows.some(row => row.game === real.boxes[1]), `${real.label}: the stored box of ${real.boxes[1]} omits him`)
    assert.deepEqual(rows.at(-1), { game: real.boxes[0], game_date: pastDay, did_not_play: false, member: true }, `${real.label}: his last stored listing shows him playing`)
  }

  // Refresh 2: complete (every part 200, 30 teams, 510 athletes, no import failure) and naming none of the four.
  assert.ok(fillers.length > 350)
  const second = await refresh('refresh 2', fillers)
  const after: Record<string, Record<string, unknown>> = {}
  for (const real of reals) after[real.label] = (await identity(real.person))!
  observations.push({ case: 'refresh-2-played-last', released: second.released ?? null, releaseHeld: second.releaseHeld ?? null, releaseSkipped: second.releaseSkipped ?? null,
    teams: Object.fromEntries(reals.map(real => [real.label, after[real.label].nba_team])) })
  console.log(JSON.stringify(observations.at(-1)))
  assert.deepEqual(second.releaseSkipped, [], 'Refresh 2 is complete: nothing blocks the sweep')
  for (const real of reals) {
    assert.equal(after[real.label].nba_team, real.team, `${real.label}: a box omission after a box that shows him playing is not proof that he left`)
    assert.deepEqual(after[real.label], before[real.label], `${real.label}: his row, ids, names, injury and status are unchanged`)
    assert.deepEqual(await ownership(ids[real.label]), owned[real.label], `${real.label}: ownership is unchanged`)
    assert.deepEqual(await lineups(ids[real.label]), lined[real.label], `${real.label}: lineups are unchanged`)
  }
  assert.equal(second.released, 0, 'The sweep releases nobody on an omission')
  assert.deepEqual(second.releaseHeld, { unproven: 4, unclaimed: 0 }, 'Each omitted claimed row is reported as held, unproven')

  // The third real boxes list each of them again for his team, each on a day of its own after the refresh in
  // real date order; each box row joins his one row, and his latest stored listing is his own return box.
  const returns = [...reals].sort((a, b) => realBoxes.get(a.boxes[2])!.game.gameEt.localeCompare(realBoxes.get(b.boxes[2])!.game.gameEt))
  const returnDay = Object.fromEntries(returns.map((real, day) => [real.label, day]))
  for (const real of returns) await storeBox(real.boxes[2], returnDay[real.label], `clock_timestamp()+interval '${returnDay[real.label]} days'`)
  const third: Record<string, unknown> = {}
  for (const real of reals) {
    const rows = await boxRows(ids[real.label])
    assert.deepEqual(rows.map(row => row.game), stored.filter(gameId => listedIn(gameId, real.person)), `${real.label}: he has a box row for every stored real box that lists him`)
    assert.equal(rows.at(-1)?.game, real.boxes[2], `${real.label}: his latest stored listing is his own return box`)
    assert.ok(rows.every(row => row.member), `${real.label}: each box row is a game membership`)
    const memberships = await json<string[]>(`SELECT coalesce(jsonb_agg(g.nba_game_id ORDER BY g.game_date,g.game_time),'[]')
      FROM private.player_game_memberships m JOIN nba_games g ON g.id=m.game_id WHERE m.player_id=${q(ids[real.label])}`)
    const stats = await json<{ game: string }[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'game_date',s.game_date,'home',g.home_team,
      'away',g.away_team,'did_not_play',s.did_not_play,'points',s.points,'rebounds',s.rebounds,'assists',s.assists) ORDER BY g.game_date,g.game_time),'[]')
      FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE s.player_id=${q(ids[real.label])}`)
    third[real.label] = { team: (await identity(real.person))!.nba_team, memberships, rows: stats.map(row => ({ ...row,
      real_date: realBoxes.get(row.game)!.game.gameEt.slice(0, 10), listed_for: listedIn(row.game, real.person)?.team, own_box: real.boxes.includes(row.game) })) }
  }
  observations.push({ case: 'third-boxes', players: third })

  // His fantasy team starts him on his own return box's day only.
  await sql(`INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
    VALUES ${reals.map(real => `(${q(member)},${q(league)},${q(season)},${q(ids[real.label])},1,${q(etDate(returnDay[real.label]))},'UTIL',false,now())`).join(',')};`)
  // Expected from the raw boxes: his own return box's row alone, a DNP row scoring nothing.
  const expected = Object.fromEntries(reals.map(real => {
    const row = listedIn(real.boxes[2], real.person)!
    return [real.label, row.played === '1' ? row.points + row.rebounds + row.assists : 0]
  }))
  const scoredOn = async (day: string) => (await calcWeekPointsByMember([member], season, year, 1, scoring, day, day)).get(member)
  const byPlayer: Record<string, number | undefined> = {}
  for (const real of reals) byPlayer[real.label] = await scoredOn(etDate(returnDay[real.label]))
  const points = (await calcWeekPointsByMember([member], season, year, 1, scoring, etDate(-3), etDate(3))).get(member)
  const total = Object.values(expected).reduce((sum, value) => sum + value, 0)
  observations.push({ case: 'scoring', returnDays: Object.fromEntries(reals.map(real => [real.label, etDate(returnDay[real.label])])), expected, byPlayer, total, points })
  assert.equal(expected.Conley, 0, 'Conley\'s return box lists him DNP')
  assert.ok(Object.values(expected).some(value => value > 0), 'At least one return box shows him playing')
  assert.deepEqual(byPlayer, expected, 'Each player scores his own return box on its day and nothing else')
  assert.equal(points, total, 'The week totals the four return boxes')
  const linedNow = Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await lineups(ids[real.label])])))

  // Refresh 3 lists all four again on their teams: nothing changes.
  const last = await refresh('refresh 3', [...fillers, ...reals.map(espnOf)])
  const final = Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await identity(real.person)])))
  observations.push({ case: 'refresh-3', released: last.released ?? null, releaseHeld: last.releaseHeld ?? null,
    teams: Object.fromEntries(reals.map(real => [real.label, final[real.label]?.nba_team])) })
  for (const real of reals) {
    assert.deepEqual(final[real.label], before[real.label], `${real.label}: still the same row on ${real.team}`)
    assert.equal(await rowsFor(real.person), '1', `${real.label}: still one row`)
    assert.deepEqual(await ownership(ids[real.label]), owned[real.label])
    assert.deepEqual(await lineups(ids[real.label]), linedNow[real.label])
  }
  assert.equal(last.released, 0)
  assert.deepEqual(last.releaseHeld, { unproven: 0, unclaimed: 0 })
  console.log(JSON.stringify({ provenance: 'REAL-RAW boxes, SYNTHETIC ESPN listing and clocks', recipe: 'players-t17-real-played-last', run, realDates, observations }))
} finally {
  try {
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    await sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM private.player_game_memberships WHERE game_id IN (${games.length ? games.map(q) : 'NULL'});
      DELETE FROM player_game_stats WHERE game_id IN (${games.length ? games.map(q) : 'NULL'});
      DELETE FROM nba_games WHERE id IN (${games.length ? games.map(q) : 'NULL'});
      ${year ? `DELETE FROM season_weeks WHERE season_year=${year};` : ''}
      DELETE FROM players WHERE nba_id IN (${people.map(q)}) OR espn_id LIKE ${q(`t17-${run}-%`)};
      DELETE FROM profiles WHERE id=${q(user)};
      DELETE FROM auth.users WHERE id=${q(user)};
      DELETE FROM sync_runs WHERE function_name='sync-players' AND started_at >= ${q(started)};`)
  }
}
