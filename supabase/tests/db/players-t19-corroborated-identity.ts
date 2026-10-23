import { strict as assert } from 'node:assert'

// A box that names a person with ESPN's words in another order joins the ESPN row his fantasy team owns before
// scoring, and only on corroborated evidence (resolve_player_imports_atomic, nba_cdn). Production order:
// sync-players (PLAYER_SYNC_SOURCE=espn) lists him and runs its NBA index step, his fantasy team owns and starts
// him, the real CDN box import (syncStatsGame) stores each final box, and sync-scores (the product's own weekly
// finalization) closes each week as it ends; then the next sync-players runs on the pinned index and sync-scores
// runs again.
// REAL-RAW (players-t19-real-boxes/README.md): Yongxi Cui's 25 Brooklyn boxes of 2024-25, in each of which he is
// "Cui Yongxi" (ESPN 5159486 "Yongxi Cui"), Jakob Poeltl's box of 2024-10-23 ("Jakob Pöltl", ESPN 3134908), and
// the pinned NBA player index, which does not list Cui. SYNTHETIC: the ESPN listing (30 teams), the league, the
// clocks, and every case below marked SYNTHETIC.
// Real case. The boxes are stored in real tip-off order, each on its real date's offset from 2024-10-23, and the
// eight seven-day weeks finalize one by one. Cui has no index row; his evidence is that ESPN lists one row on BKN
// with the words of his name, since before each game and on no other team, that row has no NBA id, and no other
// BKN player in the box has those words. His first box binds his NBA id to the owned ESPN row, so every box row
// lands on it and each week finalizes with his points (an independent sum of the raw box lines). The control,
// Poeltl, is indexed, but the first sync-players runs without his index row (the index lags a signing); his names
// differ beyond word order (Pöltl/Poeltl), so the rule leaves him split and his week finalizes without his points.
// The next sync-players on the pinned index merges his rows, and sync-scores recomputes the finalized week.
// SYNTHETIC cases; each fails if joined unless marked positive, and in each only the named condition fails:
// - P1 (positive): listed on BKN before tip-off and relisted there after it; the reordered box name binds.
// - N5 then P2 (positive): ESPN listed him on LAL at tip-off and on BKN only later, so his first BKN box is held
//   and makes a row for his NBA id alone; his next BKN box tips off after the BKN listing and merges that row into
//   the ESPN row, and the finalized week his fantasy team started him in is recomputed.
// - N1: the only ESPN row with those words is on another team.
// - N2: two ESPN rows on the box's side have the same words.
// - N3: two players on the box's side have the same words.
// - N4: the ESPN row already carries another person's NBA id (an earlier box joined it by its exact name).
// - N6: listed on BKN at tip-off, then on LAL before the box is stored.
// - N7: the box's side lists ESPN's exact name (another person) and the reversed one; the reversed one is held.
// - N8, N8b: the box name has a word more, or a word less.
// - N9a, N9b: the row holding his NBA id carries an ESPN id, or a Sleeper id, so it is not merged.
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
const sha256 = async (body: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), byte => byte.toString(16).padStart(2, '0')).join('')
const log = (value: Record<string, unknown>) => console.log(JSON.stringify(value))

// The real boxes, checked against their pinned SHA-256 and served unchanged.
type Line = { personId: number; name: string; played: string; statistics: { points: number; reboundsTotal: number; assists: number } }
type Side = { teamTricode: string; score: number; players: Line[] }
type Game = { gameId: string; gameEt: string; gameTimeUTC: string; gameStatus: number; homeTeam: Side; awayTeam: Side }
const fixtures = new URL('./players-t19-real-boxes/', import.meta.url)
const realBoxes = new Map<string, { body: Uint8Array; game: Game }>()
for await (const entry of Deno.readDir(fixtures)) {
  const pinned = entry.name.match(/^boxscore-(\d{10})-([0-9a-f]{64})\.json\.gz$/)
  if (!pinned) continue
  const file = await Deno.open(new URL(entry.name, fixtures))
  const body = new Uint8Array(await new Response(file.readable.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  assert.equal(await sha256(body), pinned[2], `${entry.name}: the body must match its pinned SHA-256`)
  const { game } = JSON.parse(new TextDecoder().decode(body)) as { game: Game }
  assert.equal(game.gameId, pinned[1])
  assert.equal(game.gameStatus, 3, `${pinned[1]} is a final box`)
  realBoxes.set(pinned[1], { body, game })
}
assert.equal(realBoxes.size, 26, 'All 26 pinned boxes are present')
const lineOf = (gameId: string, person: number) => {
  const { homeTeam, awayTeam } = realBoxes.get(gameId)!.game
  for (const side of [homeTeam, awayTeam]) {
    const line = side.players.find(player => player.personId === person)
    if (line) return { team: side.teamTricode, line }
  }
  return null
}
// The league's scoring: one point per point, rebound and assist.
const settings = { points: 1, rebounds: 1, assists: 1 }
const fantasy = (line: Line) => line.played === '1' ? line.statistics.points + line.statistics.reboundsTotal + line.statistics.assists : 0

// The pinned real NBA player index (tests/fixtures/identity/README.md).
const indexBody = await Deno.readFile(new URL('../../../tests/fixtures/identity/player-index.json', import.meta.url))
assert.equal(await sha256(indexBody), '535d3e59be84f9dd6ff194bc968b6d6cbb4f8cd5fa30380012bf7cd02110c966', 'The pinned player index is unchanged')
type Index = { resultSets: { headers: string[]; rowSet: unknown[][] }[] }
const index = JSON.parse(new TextDecoder().decode(indexBody)) as Index
const column = (name: string) => index.resultSets[0].headers.indexOf(name)
const indexRow = (person: number) => index.resultSets[0].rowSet.filter(row => row[column('PERSON_ID')] === person)

type Person = { label: string; espn: string; first: string; last: string; team: string; person: number; cdnName: string }
const cui: Person = { label: 'Cui', espn: '5159486', first: 'Yongxi', last: 'Cui', team: 'BKN', person: 1642385, cdnName: 'Cui Yongxi' }
const poeltl: Person = { label: 'Poeltl', espn: '3134908', first: 'Jakob', last: 'Poeltl', team: 'TOR', person: 1627751, cdnName: 'Jakob Pöltl' }
const order = [...realBoxes.keys()].sort((a, b) => realBoxes.get(a)!.game.gameTimeUTC.localeCompare(realBoxes.get(b)!.game.gameTimeUTC) || a.localeCompare(b))
const cuiGames = order.filter(gameId => lineOf(gameId, cui.person))
assert.equal(cuiGames.length, 25, 'Cui is in 25 of the boxes')
for (const gameId of cuiGames) {
  const found = lineOf(gameId, cui.person)!
  assert.deepEqual([found.team, found.line.name], [cui.team, cui.cdnName], `${gameId}: his real box lists him for BKN as Cui Yongxi`)
}
const poeltlGame = '0022400067'
assert.deepEqual(order.filter(gameId => lineOf(gameId, poeltl.person)), [poeltlGame], 'Poeltl is in one box')
assert.deepEqual([lineOf(poeltlGame, poeltl.person)!.team, lineOf(poeltlGame, poeltl.person)!.line.name, lineOf(poeltlGame, poeltl.person)!.line.played],
  [poeltl.team, poeltl.cdnName, '1'], 'His real box lists him playing for TOR as Jakob Pöltl')
assert.equal(indexRow(cui.person).length, 0, 'The pinned index does not list Cui')
assert.deepEqual(indexRow(poeltl.person).map(row => [row[column('PLAYER_FIRST_NAME')], row[column('PLAYER_LAST_NAME')], row[column('ROSTER_STATUS')]]),
  [[poeltl.first, poeltl.last, 1]], 'The pinned index lists Poeltl once, under ESPN\'s name, on a roster')
const withoutPoeltl = new TextEncoder().encode(JSON.stringify({ ...index, resultSets: [{ ...index.resultSets[0],
  rowSet: index.resultSets[0].rowSet.filter(row => row[column('PERSON_ID')] !== poeltl.person) }, ...index.resultSets.slice(1)] }))

// Each box on its real date's offset from the first box's date, in weeks of seven days.
const etDay = (gameId: string) => realBoxes.get(gameId)!.game.gameEt.slice(0, 10)
const dayOf = (gameId: string) => (Date.parse(`${etDay(gameId)}T00:00:00Z`) - Date.parse(`${etDay(order[0])}T00:00:00Z`)) / 86_400_000
const weekCount = 8
const weekOf = (day: number) => Math.floor(day / 7) + 1
assert.ok(order.every(gameId => weekOf(dayOf(gameId)) <= weekCount), 'Every box falls in the eight weeks')

// SYNTHETIC: the listing's other athletes (17 per team) and the collision cases. Each case's ESPN row has
// ESPN's team at sync-players 1 and from sync-players 2 on.
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const run = crypto.randomUUID().slice(0, 8)
const words = (...parts: string[]) => parts.map(part => `${part}${run}`).join(' ')
type Athlete = { espn: string; first: string; last: string; team: string }
const fillers: Athlete[] = codes.flatMap((team, index) => Array.from({ length: 17 }, (_, slot) => ({ espn: `t19-${run}-${index}-${slot}`, first: 'Synthetic', last: `T19${run}t${index}s${slot}`, team })))
assert.ok(fillers.length > 350)
type Listed = Athlete & { key: string; later: string }
const athlete = (key: string, first: string, last: string[], team: string, later = team): Listed =>
  ({ key, espn: `t19-${run}-${key}`, first: words(first), last: words(...last), team, later })
const espnCase = {
  p1: athlete('p1', 'Pa', ['Pb'], 'BKN'),
  p2: athlete('p2', 'Sa', ['Sb'], 'LAL', 'BKN'),
  n1: athlete('n1', 'Na', ['Nb'], 'LAL'),
  n2a: athlete('n2a', 'Ka', ['Kb', 'Kc'], 'BKN'),
  n2b: athlete('n2b', 'Kc', ['Ka', 'Kb'], 'BKN'),
  n3: athlete('n3', 'Ma', ['Mb', 'Mc'], 'BKN'),
  n4: athlete('n4', 'Ra', ['Rb'], 'BKN'),
  n6: athlete('n6', 'Ta', ['Tb'], 'BKN', 'LAL'),
  n7: athlete('n7', 'Ua', ['Ub'], 'BKN'),
  n8: athlete('n8', 'Va', ['Vb'], 'BKN'),
  n8b: athlete('n8b', 'Wa', ['Wb', 'Wc'], 'BKN'),
  n9a: athlete('n9a', 'Xa', ['Xb'], 'BKN'),
  n9aLal: athlete('n9a-lal', 'Xb', ['Xa'], 'LAL'),
  n9b: athlete('n9b', 'Ya', ['Yb'], 'BKN'),
}
// The box persons of the cases: an NBA id and the name the synthetic box lists.
const boxPerson = (offset: number, name: string) => ({ person: 1_919_190_000 + offset, name })
const who = {
  P1: boxPerson(1, words('Pb', 'Pa')), S: boxPerson(2, words('Sb', 'Sa')), N1: boxPerson(3, words('Nb', 'Na')), K1: boxPerson(4, words('Kb', 'Kc', 'Ka')),
  M1: boxPerson(5, words('Mb', 'Mc', 'Ma')), M2: boxPerson(6, words('Mc', 'Mb', 'Ma')), R1: boxPerson(7, words('Ra', 'Rb')), R2: boxPerson(8, words('Rb', 'Ra')),
  T1: boxPerson(9, words('Tb', 'Ta')), U1: boxPerson(10, words('Ua', 'Ub')), U2: boxPerson(11, words('Ub', 'Ua')), V1: boxPerson(12, words('Vb', 'Va', 'Vc')),
  W1: boxPerson(13, words('Wb', 'Wa')), X1: boxPerson(14, words('Xb', 'Xa')), Y1: boxPerson(15, words('Yb', 'Ya')),
}
type BoxLine = { personId: number; name: string; played: string; status: string; statistics: Record<string, number | string> }
const line = (who: { person: number; name: string }, points: number): BoxLine => ({
  personId: who.person, name: who.name, played: '1', status: 'ACTIVE',
  statistics: { minutes: 'PT20M00.00S', points, reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0,
    assists: 0, steals: 0, blocks: 0, turnovers: 0, foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0, threePointersMade: 0,
    threePointersAttempted: 0, freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0 },
})
// P2's two synthetic lines; his fantasy team starts him on both days.
const p2Points = { held: 7, merged: 5 }

// The served origin: the listing of the current phase, the index of the current step and the boxes.
let phase = 1
const listing = () => [...fillers, ...[cui, poeltl].map(p => ({ espn: p.espn, first: p.first, last: p.last, team: p.team })),
  ...Object.values(espnCase).map(c => ({ espn: c.espn, first: c.first, last: c.last, team: phase === 1 ? c.team : c.later }))]
let served: Uint8Array<ArrayBuffer> = withoutPoeltl
const syntheticBoxes = new Map<string, unknown>()
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), box = route.match(/^\/cdn\/liveData\/boxscore\/boxscore_(.+)\.json$/)
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map(abbreviation => ({ team: { id: String(codes.indexOf(abbreviation) + 1), abbreviation } })) }] }] })
  if (roster) {
    const team = codes[Number(roster[1]) - 1]
    return Response.json({ athletes: listing().filter(listed => listed.team === team).map(listed => ({ id: listed.espn, firstName: listed.first, lastName: listed.last,
      fullName: `${listed.first} ${listed.last}`, position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 1 } })) })
  }
  if (route === '/site/injuries') return Response.json({ injuries: [] })
  if (route === '/site/news') return Response.json({ articles: [] })
  if (route === '/cdn/staticData/playerIndex.json') return new Response(served.slice(), { headers: { 'content-type': 'application/json' } })
  if (box && realBoxes.has(box[1])) return new Response(realBoxes.get(box[1])!.body.slice(), { headers: { 'content-type': 'application/json' } })
  if (box && syntheticBoxes.has(box[1])) return Response.json({ game: syntheticBoxes.get(box[1]) })
  if (route.startsWith('/career/')) return Response.json({})
  return new Response('served origin has no such route', { status: 404 })
})
const origin = `http://127.0.0.1:${originPort}`
Deno.env.set('PLAYER_SYNC_SOURCE', 'espn')
Deno.env.set('ESPN_SITE_BASE_URL', `${origin}/site`)
Deno.env.set('ESPN_CAREER_BASE_URL', `${origin}/career`)
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/cdn`)
Deno.env.set('SLEEPER_BASE_URL', `${origin}/sleeper`)

// The handlers run in this process; every request must stay on this stack, the origin or a handler. Every
// nba_cdn result the import marks as linked by the rule is kept as a receipt.
type Link = { game: string; person: string; name: string; side: string | null; player_id: string; action: string; linked: string }
const links: Link[] = []
const workers: Deno.HttpServer<Deno.NetAddr>[] = []
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input)
  assert.ok([new URL(api).origin, origin, ...workers.map(worker => `http://127.0.0.1:${worker.addr.port}`)].includes(target.origin), `Refused request to ${target.origin}`)
  const response = await nativeFetch(input, init)
  if (target.pathname === '/rest/v1/rpc/resolve_player_imports_atomic' && typeof init?.body === 'string' && response.ok) {
    const sent = JSON.parse(init.body) as { p_source: string; p_records: Record<string, string>[] }
    if (sent.p_source === 'nba_cdn') {
      const { results } = await response.clone().json() as { results: { index: number; player_id: string; action: string; linked?: string }[] }
      for (const result of results.filter(result => result.linked)) {
        const record = sent.p_records[result.index]
        links.push({ game: record.nba_game_id, person: record.provider_id, name: record.display_name, side: record.nba_team ?? null,
          player_id: result.player_id, action: result.action, linked: result.linked! })
      }
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
async function invoke(worker: Deno.HttpServer<Deno.NetAddr>, body: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${worker.addr.port}`, { method: 'POST', headers: { 'x-internal-function-token': token!, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const users = [crypto.randomUUID(), crypto.randomUUID()], league = crypto.randomUUID(), season = crypto.randomUUID()
const members = { A: crypto.randomUUID(), B: crypto.randomUUID() }
const games: string[] = []
const started = new Date().toISOString()
let year = 0, base = '', fresh = false
const dateOf = (day: number) => new Date(Date.parse(`${base}T00:00:00Z`) + day * 86_400_000).toISOString().slice(0, 10)
// Every check is recorded, so one run reports every failing one; the run fails at the end if any did.
const failures: string[] = []
const check = (ok: boolean, message: string, detail?: unknown) => {
  if (!ok) failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

type Row = { id: string; espn_id: string | null; nba_id: string | null; sleeper_id: string | null; display_name: string; espn_listing: Record<string, unknown> | null; box_rows: string[] }
const playerRows = (where: string) => json<Row[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'espn_id',p.espn_id,'nba_id',p.nba_id,
  'sleeper_id',p.sleeper_id,'display_name',p.display_name,'nba_team',p.nba_team,
  'espn_listing',(SELECT to_jsonb(l)-'player_id' FROM private.player_espn_listings l WHERE l.player_id=p.id),
  'box_rows',(SELECT coalesce(jsonb_agg(g.nba_game_id ORDER BY g.game_time,g.nba_game_id),'[]') FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE s.player_id=p.id))
  ORDER BY p.created_at,p.id),'[]') FROM players p WHERE ${where}`)
// Every player row that is his by ESPN id, NBA id or either name key, oldest first.
const rowsOf = (p: Person) => playerRows(`p.espn_id=${q(p.espn)} OR p.nba_id=${q(String(p.person))}
  OR private.player_import_name_key(p.display_name) IN (private.player_import_name_key(${q(`${p.first} ${p.last}`)}),private.player_import_name_key(${q(p.cdnName)}))`)
type BoxRow = { game: string; game_date: string; player_id: string; did_not_play: boolean; points: number; rebounds: number; assists: number; membership: { side: string | null } | null }
const boxRowsOf = (p: Person) => json<BoxRow[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'game_date',g.game_date,'player_id',s.player_id,
  'did_not_play',s.did_not_play,'points',s.points,'rebounds',s.rebounds,'assists',s.assists,
  'membership',(SELECT jsonb_build_object('side',m.nba_team) FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id))
  ORDER BY g.game_time,g.nba_game_id),'[]') FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id
  WHERE s.player_id IN (SELECT id FROM players WHERE nba_id=${q(String(p.person))} OR espn_id=${q(p.espn)})`)
const memberSql = `CASE r.member_id WHEN ${q(members.A)}::uuid THEN 'A' ELSE 'B' END`
type Owned = { member: string; player_id: string; espn_id: string | null; nba_id: string | null; display_name: string }
const ownership = () => json<Owned[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('member',${memberSql},'player_id',r.player_id,'espn_id',pl.espn_id,'nba_id',pl.nba_id,
  'display_name',pl.display_name) ORDER BY ${memberSql},r.player_id),'[]') FROM roster_players r JOIN players pl ON pl.id=r.player_id WHERE r.league_id=${q(league)}`)
type Lined = { member: string; player_id: string; game_date: string; week: number; slot: string }
const lineups = () => json<Lined[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('member',${memberSql},'player_id',r.player_id,'game_date',r.game_date,'week',r.week_number,
  'slot',r.slot_type) ORDER BY r.game_date,r.member_id),'[]') FROM weekly_lineups r WHERE r.league_id=${q(league)}`)
type Matchup = { week: number; A: number | null; B: number | null; is_finalized: boolean; finalized_at: string | null }
const matchups = () => json<Matchup[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('week',week_number,'A',home_points,'B',away_points,'is_finalized',is_finalized,
  'finalized_at',finalized_at) ORDER BY week_number),'[]') FROM matchups WHERE league_id=${q(league)}`)

try {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: a refresh may release any teamed player it does not list')
  assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE nba_game_id IN (${order.map(q)})`), '0', 'The real game ids must be free on this stack')
  year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
  assert.ok(year)
  base = await sql(`SELECT (now() AT TIME ZONE 'America/New_York')::date`)
  fresh = true
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const scorer = await serve(() => import('../../functions/sync-scores/index.ts'))
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')

  const refresh = async (step: string, body: Uint8Array<ArrayBuffer>, next: number) => {
    served = body
    phase = next
    const response = await invoke(sync)
    assert.equal(response.status, 200, `${step}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.ok, true, `${step}: ${JSON.stringify(response.body)}`)
    const { inserted, updated, nbaIdsMapped, merged } = response.body
    return { inserted, updated, nbaIdsMapped, merged }
  }
  const score = async (reference: string) => {
    const response = await invoke(scorer, { leagueId: league, date: reference })
    assert.equal(response.status, 200, `sync-scores ${reference}: ${JSON.stringify(response.body)}`)
    const rows = await matchups()
    log({ scoring: reference, response: response.body, matchups: rows })
    return rows
  }
  const observe = async (stage: string, extra: Record<string, unknown> = {}) => {
    const observation = { stage, ...extra, rows: { Cui: await rowsOf(cui), Poeltl: await rowsOf(poeltl) }, boxRows: { Cui: await boxRowsOf(cui), Poeltl: await boxRowsOf(poeltl) },
      owned: await ownership(), lined: await lineups(), matchups: await matchups() }
    log(observation)
    return observation
  }

  // 1. sync-players lists Cui, Poeltl and the case rows; its index step runs on the index without Poeltl's row.
  await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES ${Array.from({ length: weekCount }, (_, i) => `(${year},${i + 1},${q(dateOf(7 * i))},${q(dateOf(7 * i + 6))})`).join(',')}`)
  const first = await refresh('sync-players 1', withoutPoeltl, 1)
  // A moment after the first listing and before the second: the tip-off of the cases' "between" games.
  const between = await sql('SELECT clock_timestamp()')
  const espnRow = await json<Record<string, string>>(`SELECT coalesce(jsonb_object_agg(espn_id,id),'{}') FROM players WHERE espn_id IN (${[cui.espn, poeltl.espn, espnCase.p2.espn].map(q)})`)
  // Fantasy team A owns Cui and starts him on each of his game days; B owns Poeltl and P2 and starts them on theirs.
  const p2Days = { held: 52, merged: 53 }
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) SELECT u,u::text||'@example.test',jsonb_build_object('username',u::text) FROM unnest(ARRAY[${users.map(q)}]::uuid[]) u;
    INSERT INTO leagues(id,slug,name,commissioner_id,status,scoring_settings) VALUES(${q(league)},${q(`t19-corroborated-${run}`)},'Synthetic corroborated identity',${q(users[0])},'active',${q(JSON.stringify(settings))}::jsonb);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(members.A)},${q(league)},${q(users[0])},'commissioner','Owns Cui'),
      (${q(members.B)},${q(league)},${q(users[1])},'manager','Owns Poeltl');
    DELETE FROM lineup_slot_templates WHERE league_id=${q(league)};
    INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${q(league)},'UTIL',1);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${q(league)},${q(season)},${q(members.A)},${q(espnRow[cui.espn])},'draft'),
      (${q(league)},${q(season)},${q(members.B)},${q(espnRow[poeltl.espn])},'draft'),(${q(league)},${q(season)},${q(members.B)},${q(espnRow[espnCase.p2.espn])},'draft');
    INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at) VALUES
      ${[...cuiGames.map(gameId => [members.A, espnRow[cui.espn], dayOf(gameId)] as const), [members.B, espnRow[poeltl.espn], dayOf(poeltlGame)] as const,
        [members.B, espnRow[espnCase.p2.espn], p2Days.held] as const, [members.B, espnRow[espnCase.p2.espn], p2Days.merged] as const]
        .map(([member, player, day]) => `(${q(member)},${q(league)},${q(season)},${q(player)},${weekOf(day)},${q(dateOf(day))},'UTIL',false,now())`).join(',')};
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type)
      SELECT ${q(league)},${q(season)},w,${q(members.A)},${q(members.B)},'regular_season' FROM generate_series(1,${weekCount}) w;`)
  const afterListing = await observe('after sync-players 1 (index without Poeltl)', { sync: first, espnRow, base, year })

  // The independent calculation: each started player's raw box line, by week.
  const parts = [...cuiGames.map(gameId => ({ member: 'A', game: gameId, person: cui.person })), { member: 'B', game: poeltlGame, person: poeltl.person }].map(part => {
    const { line } = lineOf(part.game, part.person)!
    return { ...part, realDate: etDay(part.game), day: dayOf(part.game), week: weekOf(dayOf(part.game)), played: line.played === '1',
      points: line.statistics.points, rebounds: line.statistics.reboundsTotal, assists: line.statistics.assists, fantasy: fantasy(line) }
  })
  const expected = (member: string) => Array.from({ length: weekCount }, (_, i) => parts.filter(part => part.member === member && part.week === i + 1).reduce((sum, part) => sum + part.fantasy, 0))
  const independent = { A: expected('A'), B: expected('B') }
  log({ independent, parts })

  // 2. The real CDN box import of each real final box in tip-off order, each week finalized as it ends.
  const finalizedAt: Matchup[] = []
  for (let week = 1; week <= weekCount; week++) {
    for (const gameId of order.filter(id => weekOf(dayOf(id)) === week)) {
      const { game } = realBoxes.get(gameId)!, day = dayOf(gameId), id = crypto.randomUUID()
      games.push(id)
      await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
        VALUES(${q(id)},${q(gameId)},${year},${week},${q(dateOf(day))},clock_timestamp()+interval '${day} days'+interval '${order.indexOf(gameId)} minutes',
          ${q(game.homeTeam.teamTricode)},${q(game.awayTeam.teamTricode)},'Final',${game.homeTeam.score},${game.awayTeam.score},'Final')`)
      const lines = await syncStatsGame({ id, nba_game_id: gameId, season_year: year, week_number: week, status: 'Final',
        home_score: game.homeTeam.score, away_score: game.awayTeam.score, game_status_text: 'Final' })
      assert.equal(lines, game.homeTeam.players.length + game.awayTeam.players.length, `${gameId}: every player the real box lists is stored`)
    }
    const rows = await score(`${dateOf(7 * week)}T17:00:00Z`)
    finalizedAt.push(rows.find(row => row.week === week)!)
  }
  const afterBoxes = await observe('after the real boxes, each week finalized as it ended', { finalizedAt })

  // 3. The next sync-players, on the pinned index (the case rows take their later teams), then sync-scores.
  const second = await refresh('sync-players 2', indexBody, 2)
  const afterRepair = await observe('after sync-players 2 (pinned index)', { sync: second })
  const rescored = await score(`${dateOf(7 * weekCount)}T17:00:00Z`)

  // 4. SYNTHETIC cases. A Sleeper-sourced row for N9b, then the boxes; "between" games tipped off after the first
  // listing and before the second, the others an hour after now.
  await sql(`SELECT public.resolve_player_imports_atomic('sleeper',${q(JSON.stringify([{ provider_id: `t19-${run}-sleeper`, first_name: words('Yb'), last_name: words('Ya'), metadata: {} }]))}::jsonb)`)
  const awayTeams = ['MIA', 'ATL', 'BOS', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'HOU', 'IND', 'MEM', 'MIL', 'MIN', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC']
  const stored: { label: string; gameId: string; day: number; tipoff: string; home: string; away: string; error: string | null }[] = []
  const storeCase = async (label: string, day: number, tipoff: 'between' | 'after', home: string, lines: BoxLine[]) => {
    const n = stored.length, id = crypto.randomUUID(), gameId = `002t19${run}${String(n).padStart(2, '0')}`, away = awayTeams[n]
    games.push(id)
    syntheticBoxes.set(gameId, { gameId, gameStatus: 3, gameStatusText: 'Final', homeTeam: { teamTricode: home, score: 100, players: lines },
      awayTeam: { teamTricode: away, score: 90, players: [line(boxPerson(100 + n, `Synthetic Away${run}g${n}`), 0)] } })
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
      VALUES(${q(id)},${q(gameId)},${year},${weekOf(day)},${q(dateOf(day))},${tipoff === 'between' ? `${q(between)}::timestamptz` : `clock_timestamp()+interval '1 hour'`},
        ${q(home)},${q(away)},'Final',100,90,'Final')`)
    let error: string | null = null
    try {
      await syncStatsGame({ id, nba_game_id: gameId, season_year: year, week_number: weekOf(day), status: 'Final', home_score: 100, away_score: 90, game_status_text: 'Final' })
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    stored.push({ label, gameId, day, tipoff: tipoff === 'between' ? between : 'an hour after storing', home, away, error })
  }
  // Earlier boxes: R1 and X1 join by their exact names, and the Sleeper-sourced row takes Y1's NBA id.
  await storeCase('N4: R1, exact name', 54, 'after', 'BKN', [line(who.R1, 3)])
  await storeCase('N9a: X1, exact name, LAL', 54, 'after', 'LAL', [line(who.X1, 3)])
  await storeCase('N9b: Y1, exact name of the Sleeper row', 54, 'after', 'BKN', [line(who.Y1, 3)])
  await storeCase('P1', 54, 'between', 'BKN', [line(who.P1, 4)])
  await storeCase('N5 (P2 held)', p2Days.held, 'between', 'BKN', [line(who.S, p2Points.held)])
  await storeCase('N1', 54, 'after', 'BKN', [line(who.N1, 4)])
  await storeCase('N2', 54, 'after', 'BKN', [line(who.K1, 4)])
  await storeCase('N3', 54, 'after', 'BKN', [line(who.M1, 4), line(who.M2, 4)])
  await storeCase('N4: R2', 54, 'after', 'BKN', [line(who.R2, 4)])
  await storeCase('N6', 54, 'between', 'BKN', [line(who.T1, 4)])
  await storeCase('N7', 54, 'after', 'BKN', [line(who.U2, 4), line(who.U1, 4)])
  await storeCase('N8', 54, 'after', 'BKN', [line(who.V1, 4)])
  await storeCase('N8b', 54, 'after', 'BKN', [line(who.W1, 4)])
  await storeCase('N9a: X1 on BKN', 54, 'after', 'BKN', [line(who.X1, 4)])
  await storeCase('N9b: Y1 again', 54, 'after', 'BKN', [line(who.Y1, 4)])
  const heldScore = await score(`${dateOf(7 * weekCount)}T17:00:00Z`)
  await storeCase('P2 merged', p2Days.merged, 'after', 'BKN', [line(who.S, p2Points.merged)])
  const third = await refresh('sync-players 3', indexBody, 2)
  const mergedScore = await score(`${dateOf(7 * weekCount)}T17:00:00Z`)
  log({ syntheticBoxes: stored, sync: third })

  // Each case's rows: its ESPN rows and the rows of its box persons, in readable labels.
  const espnLabel = new Map(Object.values(espnCase).map(c => [c.espn, c.key]))
  const personLabel = new Map(Object.entries(who).map(([label, w]) => [String(w.person), label]))
  const gameLabel = new Map(stored.map(row => [row.gameId, row.label]))
  const caseRows = async (espn: Listed[], persons: (keyof typeof who)[]) => {
    const rows = await playerRows(`p.espn_id IN (${espn.map(c => q(c.espn)).join(',') || 'NULL'}) OR p.nba_id IN (${persons.map(p => q(String(who[p].person))).join(',') || 'NULL'})`)
    return { rows, shape: rows.map(row => [row.espn_id ? espnLabel.get(row.espn_id) ?? row.espn_id : null, row.sleeper_id ? 'sleeper' : null,
      row.nba_id ? personLabel.get(row.nba_id) ?? row.nba_id : null, row.box_rows.map(game => gameLabel.get(game) ?? game)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
  }
  const expectShape = (rows: (string | null | string[])[][]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const cases: [string, Listed[], (keyof typeof who)[], (string | null | string[])[][]][] = [
    ['P1: bound', [espnCase.p1], ['P1'], [['p1', null, 'P1', ['P1']]]],
    ['N5 then P2: held, then merged into the ESPN row', [espnCase.p2], ['S'], [['p2', null, 'S', ['N5 (P2 held)', 'P2 merged']]]],
    ['N1: namesake on another team', [espnCase.n1], ['N1'], [['n1', null, null, []], [null, null, 'N1', ['N1']]]],
    ['N2: two ESPN rows on the side with the words', [espnCase.n2a, espnCase.n2b], ['K1'], [['n2a', null, null, []], ['n2b', null, null, []], [null, null, 'K1', ['N2']]]],
    ['N3: two box players on the side with the words', [espnCase.n3], ['M1', 'M2'], [['n3', null, null, []], [null, null, 'M1', ['N3']], [null, null, 'M2', ['N3']]]],
    ['N4: the ESPN row carries another NBA id', [espnCase.n4], ['R1', 'R2'], [['n4', null, 'R1', ['N4: R1, exact name']], [null, null, 'R2', ['N4: R2']]]],
    ['N6: listed elsewhere since tip-off', [espnCase.n6], ['T1'], [['n6', null, null, []], [null, null, 'T1', ['N6']]]],
    ['N7: the reversed name of another person on the side', [espnCase.n7], ['U1', 'U2'], [['n7', null, 'U1', ['N7']], [null, null, 'U2', ['N7']]]],
    ['N8: a word more', [espnCase.n8], ['V1'], [['n8', null, null, []], [null, null, 'V1', ['N8']]]],
    ['N8b: a word less', [espnCase.n8b], ['W1'], [['n8b', null, null, []], [null, null, 'W1', ['N8b']]]],
    ['N9a: the NBA id is on a row with an ESPN id', [espnCase.n9a, espnCase.n9aLal], ['X1'], [['n9a', null, null, []], ['n9a-lal', null, 'X1', ['N9a: X1, exact name, LAL', 'N9a: X1 on BKN']]]],
    ['N9b: the NBA id is on a row with a Sleeper id', [espnCase.n9b], ['Y1'], [['n9b', null, null, []], [null, 'sleeper', 'Y1', ['N9b: Y1, exact name of the Sleeper row', 'N9b: Y1 again']]]],
  ]
  const synthetic: Record<string, unknown> = {}
  for (const [label, espn, persons, want] of cases) {
    const { rows, shape } = await caseRows(espn, persons)
    synthetic[label] = { shape, rows }
    check(same(shape, expectShape(want)), `SYNTHETIC ${label}`, { got: shape, want: expectShape(want) })
  }
  log({ syntheticCases: synthetic })
  check(stored.every(row => row.error === null), 'SYNTHETIC: every case box is stored', stored.filter(row => row.error !== null))

  // Every link the rule made in this run: Cui's first box, P1 and P2's second box, and nothing else.
  const linkLabels = links.map(link => ({ game: gameLabel.get(link.game) ?? link.game, person: personLabel.get(link.person) ?? link.person, side: link.side, linked: link.linked }))
  log({ links, linkLabels })
  check(same(linkLabels, [{ game: cuiGames[0], person: String(cui.person), side: 'BKN', linked: 'bound' }, { game: 'P1', person: 'P1', side: 'BKN', linked: 'bound' },
    { game: 'P2 merged', person: 'S', side: 'BKN', linked: 'merged' }]), 'The rule links Cui at his first box, P1 and P2\'s second box, and nothing else', linkLabels)
  check(links.every(link => link.side !== null), 'Every link comes from a record that carries its box side', links)

  // Real case: Cui is one row, the owned ESPN row, from his first box on.
  const listed = afterListing.rows.Cui
  check(same(listed.map(row => [row.espn_id, row.nba_id]), [[cui.espn, null]]), 'Cui: sync-players 1 lists him once, an ESPN row with no NBA id', listed)
  const cuiRow = espnRow[cui.espn]
  for (const [stage, observation] of [['after the real boxes', afterBoxes], ['after sync-players 2', afterRepair]] as const) {
    const rows = observation.rows.Cui
    check(same(rows.map(row => [row.id, row.espn_id, row.nba_id]), [[cuiRow, cui.espn, String(cui.person)]]), `Cui ${stage}: one row, the owned ESPN row, with his NBA id`, rows)
    const boxRows = observation.boxRows.Cui
    check(same(boxRows.map(row => [row.game, row.player_id, row.membership?.side ?? null]), cuiGames.map(gameId => [gameId, cuiRow, 'BKN'])),
      `Cui ${stage}: all 25 box rows and their BKN memberships are on that row`, boxRows.map(row => [row.game, row.player_id, row.membership]))
    check(same(observation.owned.filter(row => row.member === 'A').map(row => row.player_id), [cuiRow]), `Cui ${stage}: fantasy team A owns that row`, observation.owned)
    check(same(observation.lined.filter(row => row.member === 'A').map(row => [row.player_id, row.game_date]), cuiGames.map(gameId => [cuiRow, dateOf(dayOf(gameId))])),
      `Cui ${stage}: A's lineup starts that row on each of his 25 game days`)
  }
  for (const [week, row] of finalizedAt.entries()) {
    check(row.is_finalized && Number(row.A) === independent.A[week], `Week ${week + 1}: finalizes with A's independent points`, { row, independent: independent.A[week] })
  }
  for (const row of rescored) check(Number(row.A) === independent.A[row.week - 1] && row.is_finalized, `Week ${row.week}: A's finalized points are unchanged by the repair`, row)
  for (const row of mergedScore) check(Number(row.A) === independent.A[row.week - 1] && row.is_finalized, `Week ${row.week}: A's finalized points are unchanged by the synthetic cases`, row)

  // Control: Poeltl's names differ beyond word order; split until the pinned index merges him.
  const poeltlBoxes = afterBoxes.rows.Poeltl
  check(same(poeltlBoxes.map(row => [row.espn_id, row.nba_id, row.display_name]), [[poeltl.espn, null, 'Jakob Poeltl'], [null, String(poeltl.person), poeltl.cdnName]]),
    'Poeltl after the real boxes: the rule leaves him split, the owned ESPN row and a CDN row', poeltlBoxes)
  check(afterBoxes.boxRows.Poeltl.every(row => row.player_id !== espnRow[poeltl.espn]), 'Poeltl after the real boxes: his box row is not on the owned ESPN row')
  const healed = afterRepair.rows.Poeltl
  check(healed.length === 1 && healed[0].espn_id === poeltl.espn && healed[0].nba_id === String(poeltl.person), 'Poeltl after sync-players 2: one row with both ids', healed)
  const healedId = healed[0]?.id
  check(same(afterRepair.boxRows.Poeltl.map(row => [row.game, row.player_id, row.membership?.side ?? null]), [[poeltlGame, healedId, 'TOR']]), 'Poeltl after sync-players 2: his box row and membership are on it')
  check(afterRepair.owned.some(row => row.member === 'B' && row.player_id === healedId), 'Poeltl after sync-players 2: B owns it', afterRepair.owned)
  check(afterRepair.lined.some(row => row.member === 'B' && row.player_id === healedId && row.game_date === dateOf(dayOf(poeltlGame))), 'Poeltl after sync-players 2: B\'s lineup starts it')
  const controlBefore = finalizedAt[weekOf(dayOf(poeltlGame)) - 1], controlAfter = rescored.find(row => row.week === weekOf(dayOf(poeltlGame)))!
  check(controlAfter.is_finalized && Number(controlAfter.B) === independent.B[0], 'Poeltl: sync-scores after the merge recomputes his finalized week to the independent points',
    { finalizedBeforeRepair: controlBefore, afterRepair: controlAfter, independent: independent.B[0] })

  // P2: his held box leaves the owned row without his points in a finalized week; the merge restores them.
  const week8 = (rows: Matchup[]) => rows.find(row => row.week === weekOf(p2Days.held))!
  check(Number(week8(heldScore).B) === 0, 'SYNTHETIC P2: the held box is not on the owned row, so his finalized week has none of it', week8(heldScore))
  check(week8(mergedScore).is_finalized && Number(week8(mergedScore).B) === p2Points.held + p2Points.merged, 'SYNTHETIC P2: after the merge his finalized week counts both boxes', week8(mergedScore))

  log({ provenance: 'REAL-RAW Cui and Poeltl boxes and player index; SYNTHETIC ESPN listing, league, clocks and the labelled collision cases',
    recipe: 'players-t19-corroborated-identity', run, independent, finalizedAt, rescored, controlBefore, controlAfter,
    p2: { held: week8(heldScore), merged: week8(mergedScore), independent: p2Points.held + p2Points.merged }, failures })
  assert.deepEqual(failures, [], 'Every check holds')
} finally {
  try {
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    // The stack started with no players, so every player row is this run's; the season year was free.
    if (fresh) await sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM private.player_game_memberships WHERE game_id IN (${games.map(q).join(',') || 'NULL'});
      DELETE FROM player_game_stats WHERE game_id IN (${games.map(q).join(',') || 'NULL'});
      DELETE FROM nba_games WHERE season_year=${year};
      DELETE FROM season_weeks WHERE season_year=${year};
      DELETE FROM private.score_input_revisions WHERE scope IN (${[`league:${league}`, `season:${season}`, `calendar:${year}`].map(q)})
        OR scope LIKE ${q(`nba:${year}:%`)} OR scope IN (SELECT 'player:'||id FROM players);
      DELETE FROM players;
      DELETE FROM profiles WHERE id IN (${users.map(q)});
      DELETE FROM auth.users WHERE id IN (${users.map(q)});
      DELETE FROM sync_runs WHERE function_name IN ('sync-players','sync-scores') AND started_at >= ${q(started)};`)
    if (fresh) log({ cleanup: await json(`SELECT json_build_object('players',(SELECT count(*) FROM players),'games',(SELECT count(*) FROM nba_games WHERE season_year=${year}),
      'weeks',(SELECT count(*) FROM season_weeks WHERE season_year=${year}),'leagues',(SELECT count(*) FROM leagues WHERE id=${q(league)}),
      'syncRuns',(SELECT count(*) FROM sync_runs WHERE started_at >= ${q(started)}),
      'certificates',(SELECT count(*) FROM private.score_week_certificates WHERE league_season_id=${q(season)}))`) })
  }
}
