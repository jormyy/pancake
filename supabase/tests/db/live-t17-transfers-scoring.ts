import { strict as assert } from 'node:assert'

// Real NBA transfers keep identity, ownership and scoring. Through the real sync-players, the product's CDN
// box import (syncStatsGame) and the served sync-scores worker, against a local origin that serves real
// pinned 2024-25 boxes byte for byte and an ESPN listing derived from the pinned boxes and ESPN summaries
// (live-t17-fixtures/README.md):
// - Transfers: Anthony Davis LAL -> DAL and Luka Doncic DAL -> LAL (the February 2025 trade), and Ben Simmons
//   BKN -> LAC after his buyout. When ESPN lists a player on his new team, players.nba_team follows it on the
//   same row (one row per NBA and ESPN id), injury and status follow the feed, and the fantasy roster and
//   saved lineups are unchanged.
// - Scoring across the move: each player's box rows for both teams land on that one row and count in the
//   matchup points sync-scores computes.
// - Held: Austin Reaves is omitted by ESPN from 2025-02-05 (constructed) while LAL's boxes keep listing him
//   playing. His team is held and his points count. Simmons is omitted on 2025-02-10 (constructed, between
//   BKN's last box listing him and LAC's first) and held until LAC lists him.
// Game dates are the real ET dates; each final is stored when the recipe plays it, so tipoffs follow the
// ESPN listings in the real order (the real UTC tipoffs are kept in the fixtures).
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
const log = (row: Record<string, unknown>) => console.log(JSON.stringify(row))

// Fixtures: the listing is checked against its derivation hash, each box against the store's body hash.
const fixtures = new URL('./live-t17-fixtures/', import.meta.url)
const LISTING_SHA256 = '5398c598596c0d9af64076070d6b4eb44428f945d541bb69eb8e0dc0d5e0d8d9'
const gunzip = async (path: URL) => new Uint8Array(await new Response(new Blob([await Deno.readFile(path)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
type Refresh = { date: string; rosters: Record<string, string[]>; out: string[]; index: number[]; constructed: { espn: string; person: number; omittedFrom: string }[] }
type Listing = {
  teams: [string, string, string][]; athletes: Record<string, [string, string, number]>; people: Record<string, [string, string]>
  stored: { game: string; file: string; date: string; tipoffUtc: string; bytes: number; sha256: string }[]; refreshes: Refresh[]
}
const listingBody = await gunzip(new URL('listing.json.gz', fixtures))
assert.equal(await sha256(listingBody), LISTING_SHA256, 'listing.json.gz is the committed derivation')
const listing = JSON.parse(new TextDecoder().decode(listingBody)) as Listing
type Line = { personId: number; played: string; notPlayingReason?: string; statistics: Record<string, number> }
type Box = { gameId: string; gameStatus: number; homeTeam: { teamTricode: string; score: number; players: Line[] }; awayTeam: { teamTricode: string; score: number; players: Line[] } }
const bodies = new Map<string, Uint8Array<ArrayBuffer>>(), boxes = new Map<string, Box>()
for (const stored of listing.stored) {
  const body = await gunzip(new URL(stored.file, fixtures))
  assert.equal(body.length, stored.bytes)
  assert.equal(await sha256(body), stored.sha256, `${stored.game} is the pinned REAL-RAW body`)
  bodies.set(stored.game, body)
  boxes.set(stored.game, (JSON.parse(new TextDecoder().decode(body)) as { game: Box }).game)
}
const nbaCode = new Map(listing.teams.map(([abbreviation, , code]) => [abbreviation, code]))

// The tracked people, with their real ESPN and NBA ids.
const tracked = { davis: ['6583', 203076], doncic: ['3945274', 1629029], simmons: ['3907387', 1627732], reaves: ['4066457', 1630559],
  james: ['1966', 2544], irving: ['6442', 202681] } as const
type Name = keyof typeof tracked
const names = Object.keys(tracked) as Name[]
for (const name of names) assert.equal(listing.athletes[tracked[name][0]]?.[2], tracked[name][1], `${name}: ESPN ${tracked[name][0]} is NBA ${tracked[name][1]}`)
const owners: Record<'A' | 'B', Name[]> = { A: ['davis', 'doncic', 'simmons', 'reaves'], B: ['james', 'irving'] }
const settings = { points: 1, rebounds: 1, assists: 2, steals: 3, blocks: 3, turnovers: -1 }
const weeks: [number, string, string][] = [[1, '2025-01-27', '2025-02-02'], [2, '2025-02-03', '2025-02-09'], [3, '2025-02-10', '2025-02-16'], [4, '2025-02-17', '2025-02-23']]
const weekOf = (date: string) => weeks.find(([, start, end]) => start <= date && date <= end)![0]
const days = Array.from({ length: 21 }, (_, offset) => new Date(Date.parse('2025-01-27T12:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10))
// Sync-scores runs once each scoring week is over; the reference instants are Mondays at 12:00 ET.
const scoring: Record<string, string> = { '2025-02-04': '2025-02-03T17:00:00Z', '2025-02-10': '2025-02-10T17:00:00Z' }
const finalScoring = '2025-02-17T17:00:00Z'

let refresh: Refresh | undefined
const played = new Set<string>(), served: string[] = []
const athlete = (espn: string) => {
  const [full, position] = listing.athletes[espn], space = full.indexOf(' ')
  return { id: espn, firstName: space > 0 ? full.slice(0, space) : '', lastName: space > 0 ? full.slice(space + 1) : full, fullName: full,
    position: { abbreviation: position }, status: { type: 'active' } }
}
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), box = route.match(/^\/cdn\/liveData\/boxscore\/boxscore_(\d{10})\.json$/)
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: listing.teams.map(([abbreviation, id]) => ({ team: { id, abbreviation } })) }] }] })
  if (roster && refresh) {
    const team = listing.teams.find(([, id]) => id === roster[1])
    if (team) return Response.json({ athletes: refresh.rosters[team[0]].map(athlete) })
  }
  if (route === '/site/injuries' && refresh) {
    return Response.json({ injuries: [{ injuries: refresh.out.map(espn => ({ status: 'Out', athlete: { displayName: listing.athletes[espn][0] } })) }] })
  }
  if (route === '/site/news') return Response.json({ articles: [] })
  if (route === '/cdn/staticData/playerIndex.json' && refresh) {
    return Response.json({ resultSets: [{ headers: ['PERSON_ID', 'PLAYER_LAST_NAME', 'PLAYER_FIRST_NAME', 'ROSTER_STATUS'],
      rowSet: refresh.index.map(person => [person, listing.people[person][1], listing.people[person][0], 1]) }] })
  }
  // A box is served only once its game has been played, exactly as pinned.
  if (box && played.has(box[1])) {
    served.push(box[1])
    return new Response(bodies.get(box[1]), { headers: { 'content-type': 'application/json' } })
  }
  if (route.startsWith('/career/')) return Response.json({})
  return new Response('the local origin has no such route', { status: 404 })
})
const origin = `http://127.0.0.1:${originPort}`
Deno.env.set('PLAYER_SYNC_SOURCE', 'espn')
Deno.env.set('ESPN_SITE_BASE_URL', `${origin}/site`)
Deno.env.set('ESPN_CAREER_BASE_URL', `${origin}/career`)
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/cdn`)
Deno.env.set('SLEEPER_BASE_URL', `${origin}/sleeper`)

// The handlers run in this process; every request must stay on this stack, the origin or a handler.
// sync-players' own espn_release call is copied so its raw receipt can be reported.
type Receipt = { released: string[]; held: { unproven: string[]; unclaimed: string[] } }
const receipts: Receipt[] = []
const workers: Deno.HttpServer<Deno.NetAddr>[] = []
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input)
  assert.ok([new URL(api).origin, origin, ...workers.map(worker => `http://127.0.0.1:${worker.addr.port}`)].includes(target.origin), `Refused request to ${target.origin}`)
  const response = await nativeFetch(input, init)
  if (target.pathname === '/rest/v1/rpc/resolve_player_imports_atomic' && typeof init?.body === 'string' && JSON.parse(init.body).p_source === 'espn_release') {
    receipts.push(await response.clone().json())
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

const run = crypto.randomUUID().slice(0, 8), year = 2024
const users = [crypto.randomUUID(), crypto.randomUUID()], league = crypto.randomUUID(), season = crypto.randomUUID()
const members = { A: crypto.randomUUID(), B: crypto.randomUUID() }
const games: string[] = []
const started = new Date().toISOString()
let fresh = false, created = false
const ids = {} as Record<Name, string>
const espnList = names.map(name => q(tracked[name][0])).join(',')
type Row = { id: string; espn_id: string; nba_id: string | null; first_name: string; last_name: string; display_name: string; position: string | null
  status: string | null; injury_status: string | null; years_exp: number | null; nba_team: string | null }
const trackedRows = async () => {
  const rows = await json<Record<string, Row>>(`SELECT coalesce(jsonb_object_agg(espn_id, to_jsonb(p)),'{}') FROM (SELECT id,espn_id,nba_id,first_name,last_name,
    display_name,position,status,injury_status,years_exp,nba_team FROM players WHERE espn_id IN (${espnList})) p`)
  return Object.fromEntries(names.map(name => [name, rows[tracked[name][0]]])) as Record<Name, Row>
}
// Every row that could be this person: his NBA id, his ESPN id, or his ESPN or NBA name.
const sameness = (name: Name) => {
  const [espn, person] = tracked[name], [nbaFirst, nbaLast] = listing.people[person], espnName = athlete(espn)
  return sql(`SELECT count(*) FROM players WHERE nba_id=${q(String(person))} OR espn_id=${q(espn)}
    OR (lower(first_name)=lower(${q(espnName.firstName)}) AND lower(last_name)=lower(${q(espnName.lastName)}))
    OR (lower(first_name)=lower(${q(nbaFirst)}) AND lower(last_name)=lower(${q(nbaLast)}))`)
}
const ownership = () => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE league_id=${q(league)}`)
const lineups = () => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.member_id,l.game_date,l.player_id),'[]') FROM weekly_lineups l WHERE league_id=${q(league)}`)
const matchups = () => json<Record<string, unknown>[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('week',week_number,'home',home_member_id,'away',away_member_id,
  'home_points',home_points,'away_points',away_points,'home_max_possible_points',home_max_possible_points,'away_max_possible_points',away_max_possible_points,
  'is_finalized',is_finalized,'winner',winner_member_id) ORDER BY week_number),'[]') FROM matchups WHERE league_id=${q(league)}`)
const boxRows = (name: Name) => json<{ game: string; game_date: string; player_id: string; did_not_play: boolean; points: number; rebounds: number; assists: number; member: boolean }[]>(
  `SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'game_date',g.game_date,'player_id',s.player_id,'did_not_play',s.did_not_play,'points',s.points,
  'rebounds',s.rebounds,'assists',s.assists,'member',EXISTS(SELECT 1 FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id))
  ORDER BY g.game_date,g.nba_game_id),'[]') FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id
  WHERE g.season_year=${year} AND s.player_id IN (SELECT id FROM players WHERE nba_id=${q(String(tracked[name][1]))} OR espn_id=${q(tracked[name][0])})`)
const lineOf = (game: Box, person: number) => {
  for (const side of [game.homeTeam, game.awayTeam]) {
    const line = side.players.find(player => player.personId === person)
    if (line) return { team: side.teamTricode, line }
  }
  return null
}
const fantasy = (line: Line) => line.played !== '1' ? 0 : line.statistics.points * settings.points + line.statistics.reboundsTotal * settings.rebounds +
  line.statistics.assists * settings.assists + line.statistics.steals * settings.steals + line.statistics.blocks * settings.blocks + line.statistics.turnovers * settings.turnovers
// Independent of the product: the saved lineups (every owned player in UTIL every day) times the pinned box lines.
const expectedPoints = (member: 'A' | 'B', week: number) => {
  const parts: { name: Name; game: string; date: string; team: string; points: number }[] = []
  for (const stored of listing.stored.filter(row => weekOf(row.date) === week)) {
    for (const name of owners[member]) {
      const found = lineOf(boxes.get(stored.game)!, tracked[name][1])
      if (found) parts.push({ name, game: stored.game, date: stored.date, team: found.team, points: fantasy(found.line) })
    }
  }
  return { total: parts.reduce((sum, part) => sum + part.points, 0), parts }
}

try {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: a refresh may release any teamed player it does not list')
  assert.equal(await sql(`SELECT (SELECT count(*) FROM season_weeks WHERE season_year=${year})+(SELECT count(*) FROM nba_games WHERE season_year=${year})+(SELECT count(*) FROM league_seasons WHERE season_year=${year})`), '0',
    'The 2024 season must be free on this stack')
  fresh = true
  await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES ${weeks.map(([week, start, end]) => `(${year},${week},${q(start)},${q(end)})`).join(',')}`)
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const scorer = await serve(() => import('../../functions/sync-scores/index.ts'))
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')

  let owned: unknown[] = [], saved: unknown[] = []
  const refreshAt = async (next: Refresh) => {
    refresh = next
    const before = created ? await trackedRows() : null, count = receipts.length
    const response = await invoke(sync)
    assert.equal(response.status, 200, `${next.date}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.ok, true, `${next.date}: ${JSON.stringify(response.body)}`)
    assert.equal(receipts.length, count + 1, `${next.date}: sync-players sends one clean listing to espn_release`)
    const receipt = receipts.at(-1)!, after = await trackedRows()
    const labels = await json<Record<string, string>>(`SELECT coalesce(jsonb_object_agg(id, coalesce(display_name,'')||' ['||coalesce(nba_team,'-')||']'),'{}') FROM players
      WHERE id::text IN (${[...receipt.released, ...receipt.held.unproven, ...receipt.held.unclaimed].map(q).join(',') || 'NULL'})`)
    log({ refresh: next.date, constructedOmissions: next.constructed, response: response.body, releaseReceipt: receipt, receiptRows: labels, before, after })
    return { response: response.body, receipt, before, after }
  }

  // Refresh 1 (2025-01-27) creates every listed player, then the league is drafted from those rows.
  const first = await refreshAt(listing.refreshes[0])
  for (const name of names) {
    const row = first.after[name]
    assert.ok(row, `${name} is created by refresh 1`)
    ids[name] = row.id
    assert.equal(row.nba_id, String(tracked[name][1]), `${name}: the player index gives the real NBA id`)
  }
  assert.deepEqual(names.map(name => first.after[name].nba_team), ['LAL', 'DAL', 'BKN', 'LAL', 'LAL', 'DAL'])
  assert.deepEqual(first.receipt.released, [])
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ${users.map(user => `(${q(user)},${q(`${user}@example.test`)},jsonb_build_object('username',${q(user)}))`).join(',')};
    INSERT INTO leagues(id,slug,name,commissioner_id,status,scoring_settings) VALUES(${q(league)},${q(`t17-transfers-${run}`)},'Real transfers',${q(users[0])},'active',${q(JSON.stringify(settings))}::jsonb);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(members.A)},${q(league)},${q(users[0])},'commissioner','Transfers A'),
      (${q(members.B)},${q(league)},${q(users[1])},'manager','Transfers B');
    DELETE FROM lineup_slot_templates WHERE league_id=${q(league)};
    INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${q(league)},'UTIL',4);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
      VALUES ${(['A', 'B'] as const).flatMap(member => owners[member].map(name => `(${q(league)},${q(season)},${q(members[member])},${q(ids[name])},'draft','2024-10-15T16:00:00Z')`)).join(',')};
    INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
      SELECT member,${q(league)},${q(season)},player,0,day::date,'UTIL',false,'2025-01-26T17:00:00Z'
      FROM (VALUES ${(['A', 'B'] as const).flatMap(member => owners[member].map(name => `(${q(members[member])}::uuid,${q(ids[name])}::uuid)`)).join(',')}) owned(member,player)
      CROSS JOIN unnest(ARRAY[${days.map(q)}]) day;
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type)
      VALUES ${[1, 2, 3].map(week => `(${q(league)},${q(season)},${week},${q(members.A)},${q(members.B)},'regular_season')`).join(',')};`)
  created = true
  owned = await ownership()
  saved = await lineups()
  assert.equal(saved.length, days.length * 6)
  log({ league, season, members, players: ids, ownership: owned.length, lineups: saved.length, settings })

  const holds: Record<string, string[]> = {}
  const play = async (game: string) => {
    const box = boxes.get(game)!, stored = listing.stored.find(row => row.game === game)!, id = crypto.randomUUID(), week = weekOf(stored.date)
    games.push(id)
    played.add(game)
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
      VALUES(${q(id)},${q(game)},${year},${week},${q(stored.date)},clock_timestamp(),${q(box.homeTeam.teamTricode)},${q(box.awayTeam.teamTricode)},'Final',
      ${box.homeTeam.score},${box.awayTeam.score},'Final')`)
    const lines = await syncStatsGame({ id, nba_game_id: game, season_year: year, week_number: week, status: 'Final', home_score: box.homeTeam.score,
      away_score: box.awayTeam.score, game_status_text: 'Final' })
    assert.equal(lines, box.homeTeam.players.length + box.awayTeam.players.length, `${game}: every box line is stored`)
    assert.equal(await sql(`SELECT stats_synced_at IS NOT NULL FROM nba_games WHERE id=${q(id)}`), 't', `${game}: the complete final box is stored`)
    for (const name of names) {
      const found = lineOf(box, tracked[name][1])
      if (!found) continue
      const rows = (await boxRows(name)).filter(row => row.game === game)
      assert.deepEqual(rows.map(row => [row.player_id, row.did_not_play, row.points, row.member]),
        [[ids[name], found.line.played !== '1', found.line.statistics.points, true]], `${game}: ${name}'s ${found.team} line lands on his one row`)
    }
  }
  const score = async (reference: string) => {
    const response = await invoke(scorer, { leagueId: league, date: reference })
    assert.equal(response.status, 200, `sync-scores ${reference}: ${JSON.stringify(response.body)}`)
    const rows = await matchups()
    log({ scoring: reference, response: response.body, matchups: rows })
    return rows
  }

  for (const [index, next] of listing.refreshes.entries()) {
    if (scoring[next.date]) await score(scoring[next.date])
    const result = index === 0 ? first : await refreshAt(next)
    const omitted = new Set(next.constructed.map(row => row.espn))
    for (const name of names) {
      const [espn, person] = tracked[name], row = result.after[name]
      assert.equal(row.id, ids[name], `${next.date}: ${name} keeps his row`)
      assert.equal(row.nba_id, String(person), `${next.date}: ${name} keeps his NBA id`)
      assert.equal(await sameness(name), '1', `${next.date}: one row is ${name}`)
      const team = Object.entries(next.rosters).find(([, listed]) => listed.includes(espn))?.[0]
      if (omitted.has(espn) || !team) {
        assert.ok(omitted.has(espn) && !team, `${next.date}: ${name} is unlisted only by construction`)
        assert.deepEqual(row, result.before?.[name] ?? row, `${next.date}: ${name}, omitted, keeps his row unchanged (held)`)
      } else {
        assert.deepEqual([row.nba_team, row.injury_status, row.status], [nbaCode.get(team), next.out.includes(espn) ? 'Out' : null, 'Active'],
          `${next.date}: ${name} follows the feed`)
      }
    }
    assert.deepEqual(result.receipt.released, [], `${next.date}: no stored box shows anyone leaving`)
    assert.deepEqual([...result.receipt.held.unproven].sort(), next.constructed.map(row => ids[names.find(name => tracked[name][0] === row.espn)!]).sort(),
      `${next.date}: exactly the constructed omissions are held unproven`)
    holds[next.date] = result.receipt.held.unproven
    assert.deepEqual(await ownership(), owned, `${next.date}: fantasy ownership is unchanged`)
    assert.deepEqual(await lineups(), saved, `${next.date}: saved lineups are unchanged`)
    const today = listing.stored.filter(row => row.date === next.date).sort((a, b) => a.tipoffUtc.localeCompare(b.tipoffUtc))
    for (const stored of today) await play(stored.game)
  }
  const final = await score(finalScoring)

  // The transfers as the real feed shows them, and the held teams.
  const teams = (name: Name) => listing.refreshes.map(next => Object.entries(next.rosters).find(([, listed]) => listed.includes(tracked[name][0]))?.[0] ?? null)
  assert.deepEqual(teams('davis'), ['LAL', 'LAL', 'DAL', 'DAL', 'DAL', 'DAL', 'DAL', 'DAL', 'DAL'])
  assert.deepEqual(teams('doncic'), ['DAL', 'DAL', 'LAL', 'LAL', 'LAL', 'LAL', 'LAL', 'LAL', 'LAL'])
  assert.deepEqual(teams('simmons'), ['BKN', 'BKN', 'BKN', 'BKN', 'BKN', 'BKN', null, 'LAC', 'LAC'])
  assert.deepEqual(teams('reaves'), ['LAL', 'LAL', 'LAL', null, null, null, null, null, null])
  const end = await trackedRows()
  assert.deepEqual(names.map(name => end[name].nba_team), ['DAL', 'LAL', 'LAC', 'LAL', 'LAL', 'DAL'], 'Final teams: two traded, one signed, one held')
  assert.ok(Object.entries(holds).every(([date, held]) => date < '2025-02-05' || held.includes(ids.reaves)), 'Reaves is held at every refresh that omits him')
  assert.ok(holds['2025-02-10'].includes(ids.simmons), 'Simmons is held on 2025-02-10')

  // Each moved player's box rows on both teams are on his one row.
  const across: Record<string, unknown> = {}
  for (const name of ['davis', 'doncic', 'simmons', 'reaves'] as Name[]) {
    const rows = await boxRows(name)
    const expected = listing.stored.flatMap(stored => {
      const found = lineOf(boxes.get(stored.game)!, tracked[name][1])
      return found ? [{ game: stored.game, team: found.team, played: found.line.played === '1', points: found.line.statistics.points }] : []
    })
    assert.deepEqual(rows.map(row => [row.game, row.player_id, !row.did_not_play, row.points]), expected.map(row => [row.game, ids[name], row.played, row.points]), `${name}: every pinned line`)
    across[name] = rows.map((row, index) => ({ ...row, team: expected[index].team }))
  }
  assert.deepEqual([...new Set((across.davis as { team: string }[]).map(row => row.team))], ['LAL', 'DAL'])
  assert.deepEqual([...new Set((across.doncic as { team: string }[]).map(row => row.team))], ['DAL', 'LAL'])
  assert.deepEqual([...new Set((across.simmons as { team: string }[]).map(row => row.team))], ['BKN', 'LAC'])

  // Matchup points: the product's sync-scores totals equal the saved lineups times the pinned lines.
  const expected = [1, 2, 3].map(week => ({ week, A: expectedPoints('A', week), B: expectedPoints('B', week) }))
  log({ expectedPoints: expected })
  assert.deepEqual(final.map(row => [row.week, row.home, row.away, Number(row.home_points), Number(row.away_points)]),
    expected.map(row => [row.week, members.A, members.B, row.A.total, row.B.total]), 'Matchup points count every started line across the moves')
  for (const [name, game] of [['davis', '0022400648'], ['davis', '0022400741'], ['doncic', '0022400768'], ['simmons', '0022400663'], ['simmons', '0022401004'],
    ['reaves', '0022400742'], ['reaves', '0022400768']] as [Name, string][]) {
    const week = weekOf(listing.stored.find(row => row.game === game)!.date)
    assert.ok(expected[week - 1].A.parts.some(part => part.name === name && part.game === game && part.points > 0), `${name}'s ${game} line scores for A in week ${week}`)
  }
  log({ provenance: 'REAL-RAW boxes; REAL-DERIVED ESPN listing and player index; constructed omissions of Reaves (from 2025-02-05) and Simmons (2025-02-10)',
    recipe: 'live-t17-transfers-scoring', run, boxesServed: served.length, boxRows: across, finalTeams: end, matchups: final, holds })
} finally {
  try {
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    // The stack started with no players and no 2024 season, so every one of them is this run's.
    if (fresh) await sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM player_game_stats WHERE game_id IN (SELECT id FROM nba_games WHERE season_year=${year});
      DELETE FROM nba_games WHERE season_year=${year};
      DELETE FROM season_weeks WHERE season_year=${year};
      DELETE FROM private.score_input_revisions WHERE scope IN (${[`league:${league}`, `season:${season}`, `calendar:${year}`].map(q)}) OR scope LIKE ${q(`nba:${year}:%`)}
        OR scope IN (SELECT 'player:'||id FROM players);
      DELETE FROM players;
      DELETE FROM profiles WHERE id IN (${users.map(q)});
      DELETE FROM auth.users WHERE id IN (${users.map(q)});
      DELETE FROM sync_runs WHERE function_name IN ('sync-players','sync-scores') AND started_at >= ${q(started)};`)
    const residue = await sql(`SELECT json_build_object('players',(SELECT count(*) FROM players),'games',(SELECT count(*) FROM nba_games WHERE season_year=${year}),
      'weeks',(SELECT count(*) FROM season_weeks WHERE season_year=${year}),'leagues',(SELECT count(*) FROM leagues WHERE id=${q(league)}),
      'syncRuns',(SELECT count(*) FROM sync_runs WHERE started_at >= ${q(started)}),
      'certificates',(SELECT count(*) FROM private.score_week_certificates WHERE league_season_id=${q(season)}))`)
    log({ cleanup: JSON.parse(residue) })
  }
}
