import { strict as assert } from 'node:assert'

// A stored box that omits a player is not proof that he left: real NBA CDN boxes omit signed players.
// Through the real sync-stats (syncStatsGame) and sync-players code against a served origin whose NBA CDN
// boxes are nine real final boxes, byte for byte (players-t16-real-boxes/README.md), and whose ESPN listing
// is synthetic (the silent omission of players-t15-silent-omission.ts):
// - Lillard (POR): the box of 2026-02-20 lists him inactive (injured), ESPN lists him on POR, POR's box of
//   2026-02-22 omits him, and a complete ESPN refresh omits him too. POR's box of 2026-02-24 lists him again,
//   inactive with the same injury: he was signed throughout, so that refresh must hold his team.
// - Hyland (MIN): the same with his two-way boxes of 2025-02-27, 2025-02-28 (omitted; ESPN's own summary of
//   that game lists him for MIN) and 2025-03-02.
// - Bassey (MEM): his last MEM box (2025-11-05) lists him playing, MEM's next box omits him and PHI's box of
//   2026-01-26 lists him. He had left, but neither omission proves it, so that refresh holds him too; the
//   positive-evidence control is the ESPN listing on PHI, which re-teams him.
// The real dates are kept in the observations. The stored schedule puts each first box two days back, each
// second box after ESPN's listing and each third box after the refresh, the order a release would compare
// with ESPN's listing time on this clock. Identity, ownership and lineups must not change.
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

// The nine real boxes, checked against their pinned SHA-256 and served unchanged.
type BoxPlayer = { personId: number; name: string; status: string; played: string; notPlayingReason?: string; notPlayingDescription?: string }
type BoxTeam = { teamTricode: string; score: number; players: BoxPlayer[] }
type RealBox = { body: Uint8Array; game: { gameId: string; gameEt: string; gameStatus: number; homeTeam: BoxTeam; awayTeam: BoxTeam } }
const fixtures = new URL('./players-t16-real-boxes/', import.meta.url)
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
assert.equal(realBoxes.size, 9, 'All nine pinned boxes are present')
const listedIn = (gameId: string, person: number) => {
  const { homeTeam, awayTeam } = realBoxes.get(gameId)!.game
  for (const team of [homeTeam, awayTeam]) {
    const row = team.players.find(player => player.personId === person)
    if (row) return { team: team.teamTricode, status: row.status, played: row.played, reason: row.notPlayingReason ?? null, description: row.notPlayingDescription ?? null }
  }
  return null
}

// Each real player: his three boxes (listed, omitted, listed again) and where the third lists him.
type Real = { label: string; person: number; first: string; last: string; team: string; boxes: [string, string, string]; again: string; injury?: string }
const lillard: Real = { label: 'Lillard', person: 203081, first: 'Damian', last: 'Lillard', team: 'POR', boxes: ['0022500810', '0022500826', '0022500841'], again: 'POR', injury: 'Out' }
const hyland: Real = { label: 'Hyland', person: 1630538, first: 'Bones', last: 'Hyland', team: 'MIN', boxes: ['0022400849', '0022400858', '0022400873'], again: 'MIN' }
const bassey: Real = { label: 'Bassey', person: 1629646, first: 'Charles', last: 'Bassey', team: 'MEM', boxes: ['0022500176', '0022500034', '0022500657'], again: 'PHI' }
const reals = [lillard, hyland, bassey]
for (const real of reals) {
  const [first, omitted, again] = real.boxes.map(gameId => listedIn(gameId, real.person))
  assert.equal(first?.team, real.team, `${real.label}: his first box lists him on ${real.team}`)
  assert.equal(omitted, null, `${real.label}: his team's next box omits him`)
  assert.equal(again?.team, real.again, `${real.label}: the third box lists him on ${real.again}`)
  assert.ok([realBoxes.get(real.boxes[1])!.game.homeTeam.teamTricode, realBoxes.get(real.boxes[1])!.game.awayTeam.teamTricode].includes(real.team))
}

// The served ESPN origin: 30 teams of 17 synthetic athletes plus the real players ESPN lists in a refresh.
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const run = crypto.randomUUID().slice(0, 8)
type Athlete = { espn: string; first: string; last: string; team: string; injury?: string }
const fillers: Athlete[] = codes.flatMap((team, index) => Array.from({ length: 17 }, (_, slot) => ({ espn: `t16-${run}-${index}-${slot}`, first: 'Synthetic', last: `T16${run}t${index}s${slot}`, team })))
const espnOf = (real: Real, team = real.team): Athlete => ({ espn: `t16-${run}-${real.label.toLowerCase()}`, first: real.first, last: real.last, team, injury: real.injury })

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
  if (route === '/site/injuries') {
    return Response.json({ injuries: [{ injuries: feed.filter(listed => listed.injury).map(listed => ({ status: listed.injury, athlete: { displayName: `${listed.first} ${listed.last}` } })) }] })
  }
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
let year = 0
const identity = (person: number) => json<Record<string, unknown> | null>(`SELECT coalesce((SELECT to_jsonb(p) FROM (SELECT id,espn_id,nba_id,sleeper_id,first_name,last_name,
  display_name,position,eligible_positions,status,injury_status,years_exp,nba_draft_number,nba_team FROM players WHERE nba_id=${q(String(person))}) p),'null')`)
const rowsFor = (person: number) => sql(`SELECT count(*) FROM players WHERE nba_id=${q(String(person))}`)
const ownership = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE player_id=${q(id)}`)
const lineups = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.game_date,l.slot_type),'[]') FROM weekly_lineups l WHERE player_id=${q(id)}`)
const boxRows = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'did_not_play',s.did_not_play,
  'member',EXISTS(SELECT 1 FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id)) ORDER BY g.game_date,g.game_time),'[]')
  FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE s.player_id=${q(id)}`)
const observations: Record<string, unknown>[] = []
try {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: a refresh may release any teamed player it does not list')
  assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE nba_game_id IN (${[...realBoxes.keys()].map(q)})`), '0', 'The real game ids must be free on this stack')
  year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
  assert.ok(year)
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${q(user)},${q(user + '@example.test')},jsonb_build_object('username',${q(user)}));
    INSERT INTO leagues(id,slug,name,commissioner_id,status) VALUES(${q(league)},${q('t16-real-omission-' + run)},'Synthetic real omission',${q(user)},'active');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(user)},'commissioner','Real omission');
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,${q(etDate(-3))},${q(etDate(3))});`)
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
  const refresh = async (label: string, athletes: Athlete[]) => {
    feed = athletes
    const response = await invoke(sync)
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.ok, true, `${label}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  // One real final box, stored through the real CDN box import on the stored schedule's date and tip-off.
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

  // Refresh 1 lists all three on their teams and claims each CDN row by name.
  await refresh('refresh 1', [...fillers, ...reals.map(real => espnOf(real))])
  const before: Record<string, Record<string, unknown>> = {}
  for (const real of reals) {
    assert.equal(await rowsFor(real.person), '1', `${real.label}: one row carries his NBA id`)
    const row = (await identity(real.person))!
    assert.deepEqual({ id: row.id, espn: row.espn_id, team: row.nba_team }, { id: ids[real.label], espn: `t16-${run}-${real.label.toLowerCase()}`, team: real.team },
      `${real.label}: ESPN claimed the CDN row and teamed it`)
    before[real.label] = row
  }
  const owned = Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await ownership(ids[real.label])])))
  const lined = Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await lineups(ids[real.label])])))

  // Each team's next real box, played after that listing, omits him.
  for (const real of reals) await storeBox(real.boxes[1], 0, 'clock_timestamp()')
  for (const real of reals) {
    assert.equal(await sql(`SELECT count(*) FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE g.nba_game_id=${q(real.boxes[1])} AND s.player_id=${q(ids[real.label])}`), '0',
      `${real.label}: the stored box of ${real.boxes[1]} omits him`)
  }

  // Refresh 2: complete (every part 200, 30 teams, 510 athletes) and naming none of the three.
  const second = await refresh('refresh 2', fillers)
  const after: Record<string, Record<string, unknown>> = {}
  for (const real of reals) after[real.label] = (await identity(real.person))!
  observations.push({ case: 'refresh-2', released: second.released ?? null, releaseHeld: second.releaseHeld ?? null,
    teams: Object.fromEntries(reals.map(real => [real.label, after[real.label].nba_team])),
    boxRows: Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await boxRows(ids[real.label])]))) })
  console.log(JSON.stringify(observations.at(-1)))
  for (const real of reals) {
    assert.equal(after[real.label].nba_team, real.team, `${real.label}: a real box and ESPN that omit him do not prove he left, whatever his last box showed`)
    assert.deepEqual(after[real.label], before[real.label], `${real.label}: his row is unchanged`)
  }
  for (const real of reals) {
    assert.deepEqual(await ownership(ids[real.label]), owned[real.label], `${real.label}: ownership is unchanged`)
    assert.deepEqual(await lineups(ids[real.label]), lined[real.label], `${real.label}: lineups are unchanged`)
  }
  assert.equal(second.released, 0)
  assert.deepEqual(second.releaseHeld, { unproven: 3, unclaimed: 0 }, 'All three are held as unproven')

  // The third real boxes: POR and MIN list Lillard and Hyland again (still signed); PHI lists Bassey.
  // POR's box of 2026-02-24 is against MIN and also lists Hyland, playing for MIN a season later.
  for (const real of reals) await storeBox(real.boxes[2], 0, 'clock_timestamp()')
  const stored = [0, 1, 2].flatMap(step => reals.map(real => real.boxes[step]))
  const third: Record<string, unknown> = {}
  for (const real of reals) {
    const rows = await boxRows(ids[real.label]) as { game: string; did_not_play: boolean; member: boolean }[]
    assert.deepEqual(rows.map(row => row.game), stored.filter(gameId => listedIn(gameId, real.person)), `${real.label}: he has a box row for every stored real box that lists him`)
    assert.ok([real.boxes[0], real.boxes[2]].every(gameId => rows.some(row => row.game === gameId)), `${real.label}: his first and third boxes list him`)
    assert.ok(rows.every(row => row.member), `${real.label}: each box row is a game membership`)
    third[real.label] = { team: (await identity(real.person))!.nba_team, rows }
  }
  assert.equal((await identity(lillard.person))!.nba_team, 'POR', 'POR\'s next real box lists Lillard: he kept POR')
  assert.equal((await identity(hyland.person))!.nba_team, 'MIN', 'MIN\'s next real box lists Hyland: he kept MIN')
  observations.push({ case: 'third-boxes', players: third })

  // Refresh 3 lists Lillard and Hyland on their teams and Bassey on PHI: positive evidence re-teams his row.
  const last = await refresh('refresh 3', [...fillers, espnOf(lillard), espnOf(hyland), espnOf(bassey, 'PHI')])
  const final = Object.fromEntries(await Promise.all(reals.map(async real => [real.label, await identity(real.person)])))
  observations.push({ case: 'refresh-3', released: last.released ?? null, releaseHeld: last.releaseHeld ?? null,
    teams: Object.fromEntries(reals.map(real => [real.label, final[real.label]?.nba_team])) })
  assert.deepEqual(final.Bassey, { ...before.Bassey, nba_team: 'PHI' }, 'A listing on PHI re-teams the same row from MEM')
  assert.deepEqual(final.Lillard, before.Lillard)
  assert.deepEqual(final.Hyland, before.Hyland)
  assert.equal(last.released, 0)
  for (const real of reals) assert.equal(await rowsFor(real.person), '1', `${real.label}: still one row`)
  console.log(JSON.stringify({ provenance: 'REAL-RAW boxes, SYNTHETIC ESPN listing and clocks', recipe: 'players-t16-real-omission', run, realDates, observations }))
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
      DELETE FROM players WHERE nba_id IN (${people.map(q)}) OR espn_id LIKE ${q(`t16-${run}-%`)};
      DELETE FROM profiles WHERE id=${q(user)};
      DELETE FROM auth.users WHERE id=${q(user)};
      DELETE FROM sync_runs WHERE function_name='sync-players' AND started_at >= ${q(started)};`)
  }
}
