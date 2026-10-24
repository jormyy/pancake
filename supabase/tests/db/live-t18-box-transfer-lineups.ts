import { strict as assert } from 'node:assert'

// The real Ben Simmons transfer, proven only by a box, through the product's auto-lineups and scoring. Through the
// real sync-players, the product's CDN box import (syncStatsGame), the served lineup-optimizer (its scheduled fill
// path and its pre-tipoff path) and the served sync-scores worker, against a local origin that serves real pinned
// 2024-25 boxes byte for byte and an ESPN listing derived from the pinned boxes and ESPN summaries
// (live-t18-fixtures/README.md):
// - ESPN omits Simmons from 2025-02-10 through 2025-02-13 (constructed). His real 2025-02-12 Clippers box (MEM at
//   LAC, a game Brooklyn did not play, tipped off after ESPN last listed him on Brooklyn) is the only evidence that
//   he left. ESPN lists him on the Clippers from 2025-02-14. Every espn_release receipt and his row are reported;
//   his row, ids, ownership and box rows must hold.
// - Auto-lineups: the product sets is_auto_set lineups only for today's ET date (the scheduled path refuses past
//   dates; the pre-tipoff path claims only today's tipoffs). So each real game day is replayed at today's date in a
//   mirror league that rosters the same player rows: that day's real games are inserted for today with future
//   tipoffs in their real order, the scheduled fill path runs, then each tipoff is dispatched to the pre-tipoff
//   worker and its game is started. The lineup the product leaves is copied to the real date in the main league,
//   whose matchups sync-scores scores.
// - Availability: a real Clippers game day on which a rostered, healthy Simmons is not started although an open
//   slot exists. The recipe fails if there is one, after reporting every decision.
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

// Fixtures: the listing is checked against its derivation hash, each box against the store's body hash. A box
// that live-t17 already carries is read from live-t17-fixtures.
const fixtures = new URL('./live-t18-fixtures/', import.meta.url), earlier = new URL('./live-t17-fixtures/', import.meta.url)
const LISTING_SHA256 = 'df9c909594f7d591be75605a1964a75fe418c26a62b1608cdbfb1c1a47963f9b'
const gunzip = async (path: URL) => new Uint8Array(await new Response(new Blob([await Deno.readFile(path)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
const present = async (path: URL) => await Deno.stat(path).then(() => true, () => false)
type Refresh = { date: string; rosters: Record<string, string[]>; out: string[]; index: number[]; constructed: { espn: string; person: number; omittedFrom: string }[] }
type Stored = { game: string; file: string; date: string; tipoffUtc: string; bytes: number; sha256: string; home: string; away: string }
type Listing = { teams: [string, string, string][]; athletes: Record<string, [string, string, number]>; people: Record<string, [string, string]>; stored: Stored[]; refreshes: Refresh[] }
const listingBody = await gunzip(new URL('listing.json.gz', fixtures))
assert.equal(await sha256(listingBody), LISTING_SHA256, 'listing.json.gz is the committed derivation')
const listing = JSON.parse(new TextDecoder().decode(listingBody)) as Listing
type Line = { personId: number; played: string; notPlayingReason?: string; statistics: Record<string, number> }
type Box = { gameId: string; gameStatus: number; homeTeam: { teamTricode: string; score: number; players: Line[] }; awayTeam: { teamTricode: string; score: number; players: Line[] } }
const bodies = new Map<string, Uint8Array<ArrayBuffer>>(), boxes = new Map<string, Box>()
for (const stored of listing.stored) {
  const own = new URL(stored.file, fixtures)
  const body = await gunzip(await present(own) ? own : new URL(stored.file, earlier))
  assert.equal(body.length, stored.bytes)
  assert.equal(await sha256(body), stored.sha256, `${stored.game} is the pinned REAL-RAW body`)
  bodies.set(stored.game, body)
  const box = (JSON.parse(new TextDecoder().decode(body)) as { game: Box }).game
  assert.deepEqual([box.gameStatus, box.homeTeam.teamTricode, box.awayTeam.teamTricode], [3, stored.home, stored.away], `${stored.game} is a final ${stored.away} at ${stored.home}`)
  boxes.set(stored.game, box)
}
const nbaCode = new Map(listing.teams.map(([abbreviation, , code]) => [abbreviation, code]))
const byTipoff = (a: Stored, b: Stored) => a.tipoffUtc.localeCompare(b.tipoffUtc) || a.game.localeCompare(b.game)

// The tracked people by their real NBA ids; their ESPN ids come from the derived links.
const persons = { simmons: 1627732, harden: 201935, zubac: 1627826, claxton: 1629651 } as const
type Name = keyof typeof persons
const names = Object.keys(persons) as Name[]
const espnOf = Object.fromEntries(names.map(name => [name, Object.entries(listing.athletes).find(([, [, , person]]) => person === persons[name])?.[0]])) as Record<Name, string>
for (const name of names) assert.ok(espnOf[name], `${name} has a derived ESPN id`)
assert.equal(espnOf.simmons, '3907387', 'Simmons is ESPN 3907387')
const owners: Record<'A' | 'B', Name[]> = { A: ['simmons', 'harden'], B: ['zubac', 'claxton'] }
const ownerOf = (name: Name) => owners.A.includes(name) ? 'A' : 'B'
const slotCount = 2
const settings = { points: 1, rebounds: 1, assists: 2, steals: 3, blocks: 3, turnovers: -1 }
const weeks: [number, string, string][] = [[1, '2025-01-27', '2025-02-02'], [2, '2025-02-03', '2025-02-09'], [3, '2025-02-10', '2025-02-16'], [4, '2025-02-17', '2025-02-23']]
const weekOf = (date: string) => weeks.find(([, start, end]) => start <= date && date <= end)![0]
// Sync-scores runs once each scoring week is over; the reference instants are Mondays at 12:00 ET.
const scoring: Record<string, string> = { '2025-02-10': '2025-02-10T17:00:00Z', '2025-02-17': '2025-02-17T17:00:00Z' }
const finalScoring = '2025-02-24T17:00:00Z'

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
// The mirror league: a current synthetic season whose only games are today's replayed ones.
const mirror = { league: crypto.randomUUID(), season: crypto.randomUUID(), members: { A: crypto.randomUUID(), B: crypto.randomUUID() }, year: 0 }
const etNow = () => json<{ today: string; minutesLeft: number }>(`SELECT json_build_object('today',(now() AT TIME ZONE 'America/New_York')::date,
  'minutesLeft',floor(extract(epoch FROM date_trunc('day',now() AT TIME ZONE 'America/New_York')+interval '1 day'-(now() AT TIME ZONE 'America/New_York'))/60))`)
const tipoffs: string[] = []
const started = new Date().toISOString()
let fresh = false, created = false, today = ''
const ids = {} as Record<Name, string>
const espnList = names.map(name => q(espnOf[name])).join(',')
type Row = { id: string; espn_id: string; nba_id: string | null; first_name: string; last_name: string; display_name: string; position: string | null
  status: string | null; injury_status: string | null; years_exp: number | null; nba_team: string | null }
const trackedRows = async () => {
  const rows = await json<Record<string, Row>>(`SELECT coalesce(jsonb_object_agg(espn_id, to_jsonb(p)),'{}') FROM (SELECT id,espn_id,nba_id,first_name,last_name,
    display_name,position,status,injury_status,years_exp,nba_team FROM players WHERE espn_id IN (${espnList})) p`)
  return Object.fromEntries(names.map(name => [name, rows[espnOf[name]]])) as Record<Name, Row>
}
// Every row that could be this person: his NBA id, his ESPN id, or his ESPN or NBA name.
const sameness = (name: Name) => {
  const espn = espnOf[name], person = persons[name], [nbaFirst, nbaLast] = listing.people[person], espnName = athlete(espn)
  return sql(`SELECT count(*) FROM players WHERE nba_id=${q(String(person))} OR espn_id=${q(espn)}
    OR (lower(first_name)=lower(${q(espnName.firstName)}) AND lower(last_name)=lower(${q(espnName.lastName)}))
    OR (lower(first_name)=lower(${q(nbaFirst)}) AND lower(last_name)=lower(${q(nbaLast)}))`)
}
const ownership = () => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE league_id IN (${q(league)},${q(mirror.league)})`)
const lineups = () => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.member_id,l.game_date,l.player_id),'[]') FROM weekly_lineups l WHERE league_id=${q(league)}`)
type LineupRow = { member_id: string; player_id: string; slot_type: string; is_auto_set: boolean; week_number: number; game_date: string }
const mirrorLineup = () => json<LineupRow[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('member_id',member_id,'player_id',player_id,'slot_type',slot_type,
  'is_auto_set',is_auto_set,'week_number',week_number,'game_date',game_date) ORDER BY member_id,player_id),'[]') FROM weekly_lineups WHERE league_id=${q(mirror.league)} AND game_date=${q(today)}`)
const matchups = () => json<Record<string, unknown>[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('week',week_number,'home',home_member_id,'away',away_member_id,
  'home_points',home_points,'away_points',away_points,'is_finalized',is_finalized,'winner',winner_member_id) ORDER BY week_number),'[]') FROM matchups WHERE league_id=${q(league)}`)
const boxRows = (name: Name) => json<{ game: string; game_date: string; player_id: string; did_not_play: boolean; points: number; rebounds: number; assists: number; member: boolean }[]>(
  `SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'game_date',g.game_date,'player_id',s.player_id,'did_not_play',s.did_not_play,'points',s.points,
  'rebounds',s.rebounds,'assists',s.assists,'member',EXISTS(SELECT 1 FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id))
  ORDER BY g.game_date,g.nba_game_id),'[]') FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id
  WHERE g.season_year=${year} AND s.player_id IN (SELECT id FROM players WHERE nba_id=${q(String(persons[name]))} OR espn_id=${q(espnOf[name])})`)
const lineOf = (game: Box, person: number) => {
  for (const side of [game.homeTeam, game.awayTeam]) {
    const line = side.players.find(player => player.personId === person)
    if (line) return { team: side.teamTricode, line }
  }
  return null
}
const fantasy = (line: Line) => line.played !== '1' ? 0 : line.statistics.points * settings.points + line.statistics.reboundsTotal * settings.rebounds +
  line.statistics.assists * settings.assists + line.statistics.steals * settings.steals + line.statistics.blocks * settings.blocks + line.statistics.turnovers * settings.turnovers
// His pinned line on a date, in whichever stored game lists him.
const lineOn = (date: string, name: Name) => {
  for (const stored of listing.stored.filter(row => row.date === date)) {
    const found = lineOf(boxes.get(stored.game)!, persons[name])
    if (found) return { game: stored.game, team: found.team, played: found.line.played === '1', reason: found.line.notPlayingReason ?? null, points: fantasy(found.line) }
  }
  return null
}
const isStarter = (row: { slot_type: string }) => row.slot_type !== 'BE' && row.slot_type !== 'IR'
// The pre-tipoff path's own health rule: neither Out nor on an IR designation.
const healthy = (injury: string | null) => (injury ?? '').toLowerCase() !== 'out' && !(injury ?? '').toLowerCase().startsWith('ir')

try {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: a refresh may release any teamed player it does not list')
  assert.equal(await sql(`SELECT (SELECT count(*) FROM season_weeks WHERE season_year=${year})+(SELECT count(*) FROM nba_games WHERE season_year=${year})+(SELECT count(*) FROM league_seasons WHERE season_year=${year})`), '0',
    'The 2024 season must be free on this stack')
  const clock = await etNow()
  today = clock.today
  assert.ok(clock.minutesLeft >= 30, `The replay runs at today's ET date; start it at least 30 minutes before midnight ET (${clock.minutesLeft} left)`)
  assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE game_date=${q(today)}`), '0', 'No game may be scheduled today on this stack')
  mirror.year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
  assert.ok(mirror.year)
  fresh = true
  await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES ${weeks.map(([week, start, end]) => `(${year},${week},${q(start)},${q(end)})`).join(',')},
    (${mirror.year},1,${q(today)},${q(today)})`)
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const scorer = await serve(() => import('../../functions/sync-scores/index.ts'))
  const optimizer = await serve(() => import('../../functions/lineup-optimizer/index.ts'))
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

  // Refresh 1 (2025-02-08) creates every listed player, then both leagues are drafted from those rows.
  const first = await refreshAt(listing.refreshes[0])
  for (const name of names) {
    const row = first.after[name]
    assert.ok(row, `${name} is created by refresh 1`)
    ids[name] = row.id
    assert.equal(row.nba_id, String(persons[name]), `${name}: the player index gives the real NBA id`)
  }
  assert.deepEqual(names.map(name => first.after[name].nba_team), ['BKN', 'LAC', 'LAC', 'BKN'])
  assert.deepEqual(first.receipt.released, [])
  const leagueSql = (id: string, seasonId: string, seasonYear: number, ms: Record<'A' | 'B', string>, label: string) => `
    INSERT INTO leagues(id,slug,name,commissioner_id,status,scoring_settings) VALUES(${q(id)},${q(`t18-${label}-${run}`)},${q(`Box transfer ${label}`)},${q(users[0])},'active',${q(JSON.stringify(settings))}::jsonb);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(seasonId)},${q(id)},${seasonYear},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(ms.A)},${q(id)},${q(users[0])},'commissioner','Box transfer A'),
      (${q(ms.B)},${q(id)},${q(users[1])},'manager','Box transfer B');
    DELETE FROM lineup_slot_templates WHERE league_id=${q(id)};
    INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${q(id)},'UTIL',${slotCount});
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
      VALUES ${(['A', 'B'] as const).flatMap(member => owners[member].map(name => `(${q(id)},${q(seasonId)},${q(ms[member])},${q(ids[name])},'draft','2024-10-15T16:00:00Z')`)).join(',')};
    INSERT INTO lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES ${(['A', 'B'] as const).map(member => `(${q(id)},${q(seasonId)},${q(ms[member])},true)`).join(',')}
      ON CONFLICT (league_id,league_season_id,member_id) DO UPDATE SET enabled=true;`
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ${users.map(user => `(${q(user)},${q(`${user}@example.test`)},jsonb_build_object('username',${q(user)}))`).join(',')};
    ${leagueSql(league, season, year, members, 'main')}
    ${leagueSql(mirror.league, mirror.season, mirror.year, mirror.members, 'mirror')}
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type)
      VALUES ${weeks.map(([week]) => `(${q(league)},${q(season)},${week},${q(members.A)},${q(members.B)},'regular_season')`).join(',')};`)
  created = true
  owned = await ownership()
  log({ league, season, members, mirror, today, players: ids, ownership: owned.length, settings, slots: { UTIL: slotCount } })

  // One real game day replayed at today's date in the mirror league, then copied to the real date.
  type Decision = { name: Name; team: string | null; injury: string | null; hasGame: boolean; fill: string | null; auto: string | null
    box: ReturnType<typeof lineOn>; starters: number }
  const decisions: Record<string, Decision[]> = {}
  const decide = async (day: string, todays: Stored[]) => {
    const clockNow = await etNow()
    assert.equal(clockNow.today, today, 'The ET date must not change during the run')
    assert.ok(clockNow.minutesLeft >= 10, 'Too close to midnight ET to replay a game day')
    // Tipoffs at least four minutes ahead stay outside the stack's own two-minute dispatch window.
    const base = Math.floor(Date.now() / 1000) * 1000 + 240_000
    const replayed = todays.map((stored, index) => ({ stored, id: crypto.randomUUID(), tipoff: new Date(base + index * 30_000).toISOString() }))
    tipoffs.push(...replayed.map(game => game.tipoff))
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES ${replayed.map(game => `(${q(game.id)},${q(`t18m-${run}-${game.stored.game}`)},${mirror.year},1,${q(today)},${q(game.tipoff)},${q(game.stored.home)},${q(game.stored.away)},'Scheduled')`).join(',')}`)
    const filled = await invoke(optimizer, { date: today })
    assert.equal(filled.status, 200, `${day} fill: ${JSON.stringify(filled.body)}`)
    assert.deepEqual([filled.body.ok, filled.body.failed, filled.body.optimized], [true, 0, 2], `${day} fill: both mirror members are optimized: ${JSON.stringify(filled.body)}`)
    const fill = await mirrorLineup()
    const contexts = {} as Record<'A' | 'B', { players: { playerId: string; hasGame: boolean; locked: boolean; injuryStatus: string | null }[] }>
    for (const member of ['A', 'B'] as const) {
      contexts[member] = await json(`SELECT public.get_pre_tipoff_lineup_context(${q(mirror.league)},${q(mirror.season)},${q(mirror.members[member])})`)
    }
    const windows: Record<string, unknown>[] = []
    for (const game of replayed) {
      const claim = crypto.randomUUID()
      await sql(`INSERT INTO lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until,input_fingerprint)
        VALUES(${q(game.tipoff)},${q(today)},'queued',${q(claim)},clock_timestamp()+interval '45 seconds',private.pre_tipoff_input_fingerprint(${q(today)}))`)
      const response = await invoke(optimizer, { mode: 'pre_tipoff', tipoffAt: game.tipoff, token: claim })
      assert.equal(response.status, 200, `${day} ${game.stored.game} pre-tipoff: ${JSON.stringify(response.body)}`)
      assert.deepEqual([response.body.ok, response.body.claimed, response.body.failed], [true, true, 0], `${day} ${game.stored.game} pre-tipoff: ${JSON.stringify(response.body)}`)
      windows.push({ game: game.stored.game, teams: `${game.stored.away} at ${game.stored.home}`, tipoff: game.tipoff, realTipoff: game.stored.tipoffUtc, response: response.body,
        dispatch: await json(`SELECT to_jsonb(d) FROM lineup_tipoff_dispatches d WHERE tipoff_at=${q(game.tipoff)}`), lineup: await mirrorLineup() })
      // The game tips off; its players lock for the later windows.
      await sql(`UPDATE nba_games SET status='InProgress',started_at=clock_timestamp() WHERE id=${q(game.id)}`)
    }
    const auto = await mirrorLineup()
    const memberOf: Record<string, 'A' | 'B'> = { [mirror.members.A]: 'A', [mirror.members.B]: 'B' }
    await sql(`INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
      SELECT CASE l.member_id WHEN ${q(mirror.members.A)}::uuid THEN ${q(members.A)}::uuid ELSE ${q(members.B)}::uuid END,${q(league)},${q(season)},l.player_id,
        ${weekOf(day)},${q(day)},l.slot_type,l.is_auto_set,l.set_at FROM weekly_lineups l WHERE l.league_id=${q(mirror.league)} AND l.game_date=${q(today)};
      DELETE FROM weekly_lineups WHERE league_id=${q(mirror.league)} AND game_date=${q(today)};
      DELETE FROM lineup_tipoff_members WHERE tipoff_at IN (${replayed.map(game => q(game.tipoff)).join(',')});
      DELETE FROM lineup_tipoff_dispatches WHERE tipoff_at IN (${replayed.map(game => q(game.tipoff)).join(',')});
      DELETE FROM nba_games WHERE id IN (${replayed.map(game => q(game.id)).join(',')});`)
    const rows = await trackedRows()
    const slotOf = (lineup: LineupRow[], name: Name) => lineup.find(row => row.player_id === ids[name] && memberOf[row.member_id] === ownerOf(name) && isStarter(row))?.slot_type ?? null
    decisions[day] = names.map(name => ({ name, team: rows[name].nba_team, injury: rows[name].injury_status,
      hasGame: contexts[ownerOf(name)].players.find(player => player.playerId === ids[name])!.hasGame,
      fill: slotOf(fill, name), auto: slotOf(auto, name), box: lineOn(day, name),
      starters: auto.filter(row => memberOf[row.member_id] === ownerOf(name) && isStarter(row)).length }))
    log({ autoLineups: day, replayedAt: today, games: todays.map(stored => `${stored.game} ${stored.away} at ${stored.home} ${stored.tipoffUtc}`), fillResponse: filled.body,
      fill, contexts, windows, auto, decisions: decisions[day] })
  }

  const play = async (stored: Stored) => {
    const game = stored.game, box = boxes.get(game)!, id = crypto.randomUUID(), week = weekOf(stored.date)
    played.add(game)
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
      VALUES(${q(id)},${q(game)},${year},${week},${q(stored.date)},clock_timestamp(),${q(box.homeTeam.teamTricode)},${q(box.awayTeam.teamTricode)},'Final',
      ${box.homeTeam.score},${box.awayTeam.score},'Final')`)
    const lines = await syncStatsGame({ id, nba_game_id: game, season_year: year, week_number: week, status: 'Final', home_score: box.homeTeam.score,
      away_score: box.awayTeam.score, game_status_text: 'Final' })
    assert.equal(lines, box.homeTeam.players.length + box.awayTeam.players.length, `${game}: every box line is stored`)
    assert.equal(await sql(`SELECT stats_synced_at IS NOT NULL FROM nba_games WHERE id=${q(id)}`), 't', `${game}: the complete final box is stored`)
    for (const name of names) {
      const found = lineOf(box, persons[name])
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

  const releases: { refresh: string; name: Name; from: string | null; to: string | null; evidence: unknown; side: string | null; proven: boolean }[] = []
  for (const [index, next] of listing.refreshes.entries()) {
    if (scoring[next.date]) await score(scoring[next.date])
    saved = await lineups()
    const result = index === 0 ? first : await refreshAt(next)
    const omitted = new Set(next.constructed.map(row => row.espn))
    for (const name of names) {
      const espn = espnOf[name], row = result.after[name], before = result.before?.[name] ?? row
      assert.equal(row.id, ids[name], `${next.date}: ${name} keeps his row`)
      assert.equal(row.nba_id, String(persons[name]), `${next.date}: ${name} keeps his NBA id`)
      assert.equal(await sameness(name), '1', `${next.date}: one row is ${name}`)
      const team = Object.entries(next.rosters).find(([, listed]) => listed.includes(espn))?.[0]
      if (omitted.has(espn) || !team) {
        assert.ok(omitted.has(espn) && !team, `${next.date}: ${name} is unlisted only by construction`)
        if (result.receipt.released.includes(ids[name])) {
          // A release may change only his team: to no team, or to the side the stored box that proves he left
          // lists him under. It is not also reported as held. An unproven release is reported and fails the run
          // after the availability receipts.
          assert.deepEqual({ ...row, nba_team: before.nba_team }, before, `${next.date}: ${name}, released, keeps everything but his team`)
          const evidence = await json<{ game: string; home: string; away: string } | null>(`SELECT coalesce((SELECT to_jsonb(e) FROM (SELECT g.nba_game_id AS game,
            g.home_team AS home,g.away_team AS away FROM nba_games g WHERE g.season_year=${year} AND g.id IN (SELECT game_id FROM player_game_stats WHERE player_id=${q(ids[name])}
            UNION SELECT game_id FROM private.player_game_memberships WHERE player_id=${q(ids[name])}) ORDER BY g.game_time DESC LIMIT 1) e),'null'::jsonb)`)
          const side = evidence ? lineOf(boxes.get(evidence.game)!, persons[name])?.team ?? null : null
          const proven = evidence !== null && ![evidence.home, evidence.away].includes(before.nba_team!) && (row.nba_team === null || row.nba_team === side)
          releases.push({ refresh: next.date, name, from: before.nba_team, to: row.nba_team, evidence, side, proven })
          assert.ok(![...result.receipt.held.unproven, ...result.receipt.held.unclaimed].includes(ids[name]), `${next.date}: ${name} is released, not held`)
        } else if (before.nba_team === null) {
          assert.deepEqual(row, before, `${next.date}: ${name}, omitted with no team, keeps his row unchanged`)
        } else {
          assert.deepEqual(row, before, `${next.date}: ${name}, omitted, keeps his row unchanged (held)`)
          assert.ok(result.receipt.held.unproven.includes(ids[name]), `${next.date}: ${name} is held unproven`)
        }
      } else {
        assert.deepEqual([row.nba_team, row.injury_status, row.status], [nbaCode.get(team), next.out.includes(espn) ? 'Out' : null, 'Active'],
          `${next.date}: ${name} follows the feed`)
      }
    }
    const tracked = new Set(Object.values(ids))
    assert.deepEqual(result.receipt.released.filter(id => !tracked.has(id)), [], `${next.date}: only a tracked omission can be released`)
    assert.deepEqual(result.receipt.held.unproven.filter(id => !tracked.has(id)), [], `${next.date}: only a constructed omission is held`)
    assert.deepEqual(await ownership(), owned, `${next.date}: fantasy ownership is unchanged`)
    assert.deepEqual(await lineups(), saved, `${next.date}: saved lineups are unchanged by the refresh`)
    const todays = listing.stored.filter(row => row.date === next.date).sort(byTipoff)
    if (todays.length > 0) {
      await decide(next.date, todays)
      for (const stored of todays) await play(stored)
    }
  }
  const final = await score(finalScoring)

  // The listing itself: Simmons on BKN, omitted 02-10 through 02-13, then on LAC.
  const teams = (name: Name) => listing.refreshes.map(next => Object.entries(next.rosters).find(([, listed]) => listed.includes(espnOf[name]))?.[0] ?? null)
  assert.deepEqual(teams('simmons'), listing.refreshes.map(next => next.date < '2025-02-10' ? 'BKN' : next.date <= '2025-02-13' ? null : 'LAC'))
  const end = await trackedRows()
  assert.deepEqual(names.map(name => end[name].nba_team), ['LAC', 'LAC', 'LAC', 'BKN'], 'Final teams follow the listing')

  // Simmons' box rows on both sides of the move are on his one row.
  const simmonsRows = await boxRows('simmons')
  const simmonsLines = [...listing.stored].sort(byTipoff).flatMap(stored => {
    const found = lineOf(boxes.get(stored.game)!, persons.simmons)
    return found ? [{ game: stored.game, date: stored.date, team: found.team, played: found.line.played === '1', reason: found.line.notPlayingReason ?? null, points: found.line.statistics.points, fantasy: fantasy(found.line) }] : []
  })
  assert.deepEqual(simmonsRows.map(row => [row.game, row.player_id, !row.did_not_play, row.points]), simmonsLines.map(row => [row.game, ids.simmons, row.played, row.points]), 'Simmons: every pinned line')

  // Matchup points: the product's sync-scores totals equal the copied auto-lineups times the pinned lines.
  const copied = await json<{ member_id: string; player_id: string; game_date: string; slot_type: string; is_auto_set: boolean }[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('member_id',member_id,
    'player_id',player_id,'game_date',game_date,'slot_type',slot_type,'is_auto_set',is_auto_set) ORDER BY game_date,member_id,player_id),'[]') FROM weekly_lineups WHERE league_id=${q(league)}`)
  const nameOf = new Map(names.map(name => [ids[name], name]))
  const expected = weeks.map(([week]) => {
    const parts = copied.filter(row => isStarter(row) && weekOf(row.game_date) === week).map(row => {
      const name = nameOf.get(row.player_id)!, line = lineOn(row.game_date, name)
      return { member: row.member_id === members.A ? 'A' : 'B', name, date: row.game_date, slot: row.slot_type, auto: row.is_auto_set, game: line?.game ?? null, team: line?.team ?? null, points: line?.points ?? 0 }
    })
    const total = (member: 'A' | 'B') => parts.filter(part => part.member === member).reduce((sum, part) => sum + part.points, 0)
    return { week, A: total('A'), B: total('B'), parts }
  })
  log({ expectedPoints: expected })
  assert.deepEqual(final.map(row => [row.week, row.home, row.away, Number(row.home_points), Number(row.away_points)]),
    expected.map(row => [row.week, members.A, members.B, row.A, row.B]), 'Matchup points count every started line')

  // Availability: every real Clippers game day of the replay from his first Clippers box on.
  const joined = simmonsLines.find(line => line.team === 'LAC')?.date
  assert.ok(joined, 'Simmons has a real Clippers box')
  const clippersDays = Object.keys(decisions).filter(day => day >= joined && listing.stored.some(stored => stored.date === day && [stored.home, stored.away].includes('LAC'))).sort()
  const availability = clippersDays.map(day => {
    const decision = decisions[day].find(row => row.name === 'simmons')!
    const lost = healthy(decision.injury) && decision.auto === null && decision.starters < slotCount
    return { day, team: decision.team, injury: decision.injury, hasGame: decision.hasGame, fill: decision.fill, auto: decision.auto, starters: decision.starters,
      box: decision.box, lost, pointsLost: lost ? decision.box?.points ?? 0 : 0 }
  })
  const falseStarts = Object.keys(decisions).sort().flatMap(day => {
    const decision = decisions[day].find(row => row.name === 'simmons')!
    return decision.auto !== null && decision.team !== decision.box?.team ? [{ day, team: decision.team, box: decision.box }] : []
  })
  // Controls: a listed, healthy player is started on each real game day of his team.
  const controls = Object.entries(decisions).flatMap(([day, rows]) => rows.filter(row => row.name !== 'simmons' && row.team && healthy(row.injury)
    && listing.stored.some(stored => stored.date === day && [stored.home, stored.away].includes(row.team!))).map(row => ({ day, name: row.name, team: row.team, auto: row.auto })))
  log({ provenance: 'REAL-RAW boxes; REAL-DERIVED ESPN listing and player index; constructed omission of Simmons (2025-02-10 through 2025-02-13)',
    recipe: 'live-t18-box-transfer-lineups', run, replayedAt: today, boxesServed: served.length, releases, simmonsLines, simmonsRows, finalTeams: end, matchups: final,
    availability, lostDays: availability.filter(row => row.lost).map(row => row.day), pointsLost: availability.reduce((sum, row) => sum + row.pointsLost, 0), falseStarts,
    controlsBenched: controls.filter(row => row.auto === null) })
  assert.deepEqual(controls.filter(row => row.auto === null), [], 'Every listed, healthy control is started on his team\'s game days')
  assert.ok(clippersDays.length >= 4 && clippersDays.includes('2025-02-13'), 'The replay covers the Clippers game days')
  assert.deepEqual(releases.filter(row => !row.proven), [], 'Every release is proven by a stored box of a game his team did not play')
  assert.deepEqual(availability.filter(row => row.lost).map(row => row.day), [],
    'A rostered, healthy Simmons is started on every real Clippers game day while a slot is open')
} finally {
  try {
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    // The stack started with no players, no 2024 season and no game today, so every one of them is this run's.
    if (fresh) await sql(`DELETE FROM leagues WHERE id IN (${q(league)},${q(mirror.league)});
      DELETE FROM lineup_tipoff_members WHERE tipoff_at IN (${tipoffs.map(q).join(',') || 'NULL'});
      DELETE FROM lineup_tipoff_dispatches WHERE tipoff_at IN (${tipoffs.map(q).join(',') || 'NULL'});
      DELETE FROM player_game_stats WHERE game_id IN (SELECT id FROM nba_games WHERE season_year IN (${year},${mirror.year}));
      DELETE FROM nba_games WHERE season_year IN (${year},${mirror.year});
      DELETE FROM season_weeks WHERE season_year IN (${year},${mirror.year});
      DELETE FROM private.score_input_revisions WHERE scope IN (${[`league:${league}`, `season:${season}`, `calendar:${year}`, `league:${mirror.league}`, `season:${mirror.season}`, `calendar:${mirror.year}`].map(q)})
        OR scope LIKE ${q(`nba:${year}:%`)} OR scope LIKE ${q(`nba:${mirror.year}:%`)} OR scope IN (SELECT 'player:'||id FROM players);
      DELETE FROM players;
      DELETE FROM profiles WHERE id IN (${users.map(q)});
      DELETE FROM auth.users WHERE id IN (${users.map(q)});
      DELETE FROM sync_runs WHERE function_name IN ('sync-players','sync-scores','lineup-optimizer') AND started_at >= ${q(started)};`)
    const residue = await sql(`SELECT json_build_object('players',(SELECT count(*) FROM players),'games',(SELECT count(*) FROM nba_games WHERE season_year IN (${year},${mirror.year || year})),
      'weeks',(SELECT count(*) FROM season_weeks WHERE season_year IN (${year},${mirror.year || year})),'leagues',(SELECT count(*) FROM leagues WHERE id IN (${q(league)},${q(mirror.league)})),
      'dispatches',(SELECT count(*) FROM lineup_tipoff_dispatches WHERE tipoff_at IN (${tipoffs.map(q).join(',') || 'NULL'})),
      'syncRuns',(SELECT count(*) FROM sync_runs WHERE started_at >= ${q(started)}),
      'certificates',(SELECT count(*) FROM private.score_week_certificates WHERE league_season_id IN (${q(season)},${q(mirror.season)})))`)
    log({ cleanup: JSON.parse(residue) })
  }
}
