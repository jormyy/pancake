import { strict as assert } from 'node:assert'

// A renamed person keeps one identity when ESPN and the NBA CDN name him differently, in the order production
// runs: sync-players (PLAYER_SYNC_SOURCE=espn) lists him under ESPN's name and its NBA player index step runs,
// then the real CDN box import (syncStatsGame) stores a real final box that lists him under the CDN's name.
// The served origin's boxes are three real final boxes and its player index is the pinned real index, byte for
// byte (players-t18-real-boxes/README.md); the ESPN listing is synthetic and complete (30 teams, more than 350
// athletes) and names each person as ESPN's own summary of the same game does:
// - Jakob Poeltl (TOR, ESPN 3134908) is "Jakob Pöltl" in TOR's box of 2024-10-23 (0022400067).
// - Alex Sarr and Bub Carrington (WAS, ESPN 5160992 and 4845374) are "Alexandre Sarr" and "Carlton Carrington"
//   in WAS's box of 2024-10-24 (0022400073).
// - Yongxi Cui (BKN, ESPN 5159486) is "Cui Yongxi" in BKN's box of 2024-10-27 (0022400098).
// Each plays in that box, and no name pair shares a player_import_name_key. The pinned index lists Poeltl, Sarr
// and Carrington under ESPN's names and does not list Cui at all.
// Case "pinned index": the index step binds each listed person's NBA id to his ESPN row before any box, so his
// box row joins that row and his fantasy team scores it. Cui has no index row, but ESPN has listed one BKN row with
// the words of his box name, in the other order, since before his box tipped off, and no other BKN row or BKN
// player in the box has them: his box binds his NBA id to that owned row (players-t19-corroborated-identity).
// Case "index without his row" (the pinned index minus the three rows; sync-players runs without a person's row,
// as it does for Cui): each box creates a CDN row of its own and the owned ESPN rows score nothing. The next
// sync-players with the pinned index binds each listed ESPN row, merges the CDN row into one identity, and the
// box, the ownership and the lineup meet on it. Cui is bound by his box as in the first case and stays one row.
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

// The three real boxes, checked against their pinned SHA-256 and served unchanged.
type BoxPlayer = { personId: number; name: string; played: string; statistics: { points: number; reboundsTotal: number; assists: number } }
type BoxTeam = { teamTricode: string; score: number; players: BoxPlayer[] }
type RealBox = { body: Uint8Array; game: { gameId: string; gameEt: string; gameStatus: number; homeTeam: BoxTeam; awayTeam: BoxTeam } }
const fixtures = new URL('./players-t18-real-boxes/', import.meta.url)
const realBoxes = new Map<string, RealBox>()
for await (const entry of Deno.readDir(fixtures)) {
  const pinned = entry.name.match(/^boxscore-(\d{10})-([0-9a-f]{64})\.json\.gz$/)
  if (!pinned) continue
  const file = await Deno.open(new URL(entry.name, fixtures))
  const body = new Uint8Array(await new Response(file.readable.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  assert.equal(await sha256(body), pinned[2], `${entry.name}: the body must match its pinned SHA-256`)
  const { game } = JSON.parse(new TextDecoder().decode(body)) as Pick<RealBox, 'game'>
  assert.equal(game.gameId, pinned[1])
  assert.equal(game.gameStatus, 3, `${pinned[1]} is a final box`)
  realBoxes.set(pinned[1], { body, game })
}
assert.equal(realBoxes.size, 3, 'All three pinned boxes are present')

// The pinned real NBA player index (tests/fixtures/identity/README.md), served unchanged in case "pinned index".
const indexBody = await Deno.readFile(new URL('../../../tests/fixtures/identity/player-index.json', import.meta.url))
assert.equal(await sha256(indexBody), '535d3e59be84f9dd6ff194bc968b6d6cbb4f8cd5fa30380012bf7cd02110c966', 'The pinned player index is unchanged')
type Index = { resultSets: { headers: string[]; rowSet: unknown[][] }[] }
const index = JSON.parse(new TextDecoder().decode(indexBody)) as Index
const column = (name: string) => index.resultSets[0].headers.indexOf(name)
const indexRow = (person: number) => index.resultSets[0].rowSet.filter(row => row[column('PERSON_ID')] === person)

// Each person: ESPN's id, team and name (ESPN's summary of the same game), and the name his real box lists.
type Person = { label: string; espn: string; first: string; last: string; espnTeam: string; team: string; person: number; cdnName: string; box: string }
const poeltl: Person = { label: 'Poeltl', espn: '3134908', first: 'Jakob', last: 'Poeltl', espnTeam: 'TOR', team: 'TOR', person: 1627751, cdnName: 'Jakob Pöltl', box: '0022400067' }
const sarr: Person = { label: 'Sarr', espn: '5160992', first: 'Alex', last: 'Sarr', espnTeam: 'WSH', team: 'WAS', person: 1642259, cdnName: 'Alexandre Sarr', box: '0022400073' }
const carrington: Person = { label: 'Carrington', espn: '4845374', first: 'Bub', last: 'Carrington', espnTeam: 'WSH', team: 'WAS', person: 1642267, cdnName: 'Carlton Carrington', box: '0022400073' }
const cui: Person = { label: 'Cui', espn: '5159486', first: 'Yongxi', last: 'Cui', espnTeam: 'BKN', team: 'BKN', person: 1642385, cdnName: 'Cui Yongxi', box: '0022400098' }
const persons = [poeltl, sarr, carrington, cui]
const indexed = [poeltl, sarr, carrington]
const listedIn = (gameId: string, person: number) => {
  const { homeTeam, awayTeam } = realBoxes.get(gameId)!.game
  for (const team of [homeTeam, awayTeam]) {
    const row = team.players.find(player => player.personId === person)
    if (row) return { team: team.teamTricode, name: row.name, played: row.played, points: row.statistics.points, rebounds: row.statistics.reboundsTotal, assists: row.statistics.assists }
  }
  return null
}
for (const p of persons) {
  const row = listedIn(p.box, p.person)
  assert.deepEqual([row?.team, row?.name, row?.played], [p.team, p.cdnName, '1'], `${p.label}: his real box lists him playing for ${p.team} as ${p.cdnName}`)
}
for (const p of indexed) {
  const rows = indexRow(p.person)
  assert.deepEqual(rows.map(row => [row[column('PLAYER_FIRST_NAME')], row[column('PLAYER_LAST_NAME')], row[column('ROSTER_STATUS')]]), [[p.first, p.last, 1]],
    `${p.label}: the pinned index lists him once, under ESPN's name, on a roster`)
}
assert.equal(indexRow(cui.person).length, 0, 'The pinned index does not list Cui')
const withoutRows = new TextEncoder().encode(JSON.stringify({ ...index, resultSets: [{ ...index.resultSets[0],
  rowSet: index.resultSets[0].rowSet.filter(row => !indexed.some(p => p.person === row[column('PERSON_ID')])) }, ...index.resultSets.slice(1)] }))

// The served origin: 30 ESPN teams of 17 synthetic athletes plus the four persons, the index of the current case
// and the real boxes.
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const run = crypto.randomUUID().slice(0, 8)
type Athlete = { espn: string; first: string; last: string; team: string }
const fillers: Athlete[] = codes.flatMap((team, index) => Array.from({ length: 17 }, (_, slot) => ({ espn: `t18-${run}-${index}-${slot}`, first: 'Synthetic', last: `T18${run}t${index}s${slot}`, team })))
const listing: Athlete[] = [...fillers, ...persons.map(p => ({ espn: p.espn, first: p.first, last: p.last, team: p.espnTeam }))]
assert.ok(fillers.length > 350)

let served: Uint8Array<ArrayBuffer> = indexBody
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), box = route.match(/^\/cdn\/liveData\/boxscore\/boxscore_(.+)\.json$/)
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map(abbreviation => ({ team: { id: String(codes.indexOf(abbreviation) + 1), abbreviation } })) }] }] })
  if (roster) {
    const team = codes[Number(roster[1]) - 1]
    return Response.json({ athletes: listing.filter(listed => listed.team === team).map(listed => ({ id: listed.espn, firstName: listed.first, lastName: listed.last,
      fullName: `${listed.first} ${listed.last}`, position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 1 } })) })
  }
  if (route === '/site/injuries') return Response.json({ injuries: [] })
  if (route === '/site/news') return Response.json({ articles: [] })
  if (route === '/cdn/staticData/playerIndex.json') return new Response(served.slice(), { headers: { 'content-type': 'application/json' } })
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
const scoring = { points: 1, rebounds: 1, assists: 1 }
const people = [...new Set([...realBoxes.values()].flatMap(({ game }) => [...game.homeTeam.players, ...game.awayTeam.players].map(player => String(player.personId))))]
// The boxes go on days of their own in real date order; each person is started on his box's day only.
const boxDays = [...realBoxes.keys()].sort((a, b) => realBoxes.get(a)!.game.gameEt.localeCompare(realBoxes.get(b)!.game.gameEt))
const dayOf = (p: Person) => boxDays.indexOf(p.box)
const expected = Object.fromEntries(persons.map(p => {
  const row = listedIn(p.box, p.person)!
  return [p.label, row.points + row.rebounds + row.assists]
}))
assert.ok(Object.values(expected).every(value => value > 0), 'Each real box row scores')

const sync = await serve(() => import('../../functions/sync-players/index.ts'))
const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
const { calcWeekPointsByMember } = await import('../../functions/_shared/scoreLineups.ts')

// Every player row that is his by ESPN id, NBA id or either name key, oldest first, with its ESPN listing.
const rowsOf = (p: Person) => json<Record<string, unknown>[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.id),'[]') FROM (
  SELECT p.id,p.espn_id,p.nba_id,p.first_name,p.last_name,p.display_name,p.nba_team,p.created_at,
    (SELECT jsonb_build_object('nba_team',l.nba_team) FROM private.player_espn_listings l WHERE l.player_id=p.id) AS espn_listing
  FROM players p WHERE p.espn_id=${q(p.espn)} OR p.nba_id=${q(String(p.person))}
    OR private.player_import_name_key(p.display_name) IN (private.player_import_name_key(${q(`${p.first} ${p.last}`)}),private.player_import_name_key(${q(p.cdnName)}))) r`)

type Stage = Record<string, unknown>
type CaseResult = { espnRow: Record<string, string>; afterBoxes: Stage; afterHeal: Stage | null; afterNames: Stage | null; stages: Stage[] }
async function runCase(label: string, firstIndex: Uint8Array<ArrayBuffer>, heal: boolean): Promise<CaseResult> {
  const user = persons.map(() => crypto.randomUUID()), member = persons.map(() => crypto.randomUUID())
  const league = crypto.randomUUID(), season = crypto.randomUUID()
  const games: string[] = []
  const started = new Date().toISOString()
  const memberOf = (p: Person) => member[persons.indexOf(p)]
  let year = 0
  const stages: Stage[] = []
  try {
    assert.equal(await sql('SELECT count(*) FROM players'), '0', `${label}: use an empty isolated stack: a refresh may release any teamed player it does not list`)
    assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE nba_game_id IN (${[...realBoxes.keys()].map(q)})`), '0', `${label}: the real game ids must be free on this stack`)
    year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
    assert.ok(year)
    await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) SELECT u,u::text||'@example.test',jsonb_build_object('username',u::text) FROM unnest(ARRAY[${user.map(q)}]::uuid[]) u;
      INSERT INTO leagues(id,slug,name,commissioner_id,status) VALUES(${q(league)},${q('t18-renamed-' + run + '-' + label)},'Synthetic renamed identity',${q(user[0])},'active');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
      INSERT INTO league_members(id,league_id,user_id,role,team_name)
        SELECT m,${q(league)},u::uuid,(CASE WHEN o=1 THEN 'commissioner' ELSE 'manager' END)::league_member_role,'Owns '||n FROM unnest(ARRAY[${member.map(q)}]::uuid[],ARRAY[${user.map(q)}]::text[],ARRAY[${persons.map(p => q(p.label))}]::text[]) WITH ORDINALITY AS x(m,u,n,o);
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,${q(etDate(-3))},${q(etDate(3))});`)
    const refresh = async (step: string, body: Uint8Array<ArrayBuffer>) => {
      served = body
      const response = await invoke(sync)
      assert.equal(response.status, 200, `${label} ${step}: ${JSON.stringify(response.body)}`)
      assert.equal(response.body.ok, true, `${label} ${step}: ${JSON.stringify(response.body)}`)
      return response.body
    }
    const observe = async (stage: string, extra: Record<string, unknown> = {}) => {
      const rows: Record<string, unknown> = {}, joins: Record<string, unknown> = {}, owned: Record<string, unknown> = {}, lined: Record<string, unknown> = {}, scored: Record<string, unknown> = {}
      for (const p of persons) {
        rows[p.label] = await rowsOf(p)
        joins[p.label] = await json(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'player_id',s.player_id,'espn_id',pl.espn_id,'nba_id',pl.nba_id,
            'display_name',pl.display_name,'did_not_play',s.did_not_play,'points',s.points,'rebounds',s.rebounds,'assists',s.assists,
            'membership',EXISTS(SELECT 1 FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id)) ORDER BY g.game_date),'[]')
          FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id JOIN players pl ON pl.id=s.player_id
          WHERE g.nba_game_id=${q(p.box)} AND (pl.nba_id=${q(String(p.person))} OR pl.espn_id=${q(p.espn)})`)
        owned[p.label] = await json(`SELECT coalesce(jsonb_agg(jsonb_build_object('player_id',r.player_id,'espn_id',pl.espn_id,'nba_id',pl.nba_id,'display_name',pl.display_name)),'[]')
          FROM roster_players r JOIN players pl ON pl.id=r.player_id WHERE r.member_id=${q(memberOf(p))}`)
        lined[p.label] = await json(`SELECT coalesce(jsonb_agg(jsonb_build_object('player_id',l.player_id,'game_date',l.game_date,'slot',l.slot_type) ORDER BY l.game_date),'[]')
          FROM weekly_lineups l WHERE l.member_id=${q(memberOf(p))}`)
        if (games.length) scored[p.label] = (await calcWeekPointsByMember([memberOf(p)], season, year, 1, scoring, etDate(dayOf(p)), etDate(dayOf(p)))).get(memberOf(p)) ?? 0
      }
      const observation = { case: label, stage, ...extra, rows, joins, owned, lined, ...(games.length ? { scored, expected } : {}) }
      stages.push(observation)
      console.log(JSON.stringify(observation))
      return observation
    }

    // 1. sync-players lists the four under ESPN's names; its index step runs on this case's index.
    const first = await refresh('sync 1', firstIndex)
    await observe('after sync-players 1', { sync: { inserted: first.inserted, nbaIdsMapped: first.nbaIdsMapped, merged: first.merged } })
    const espnRow: Record<string, string> = {}
    for (const p of persons) espnRow[p.label] = await sql(`SELECT id FROM players WHERE espn_id=${q(p.espn)}`)
    // Each fantasy team owns its person's ESPN row and starts him on his box's day.
    await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
        VALUES ${persons.map(p => `(${q(league)},${q(season)},${q(memberOf(p))},${q(espnRow[p.label])},'draft')`).join(',')};
      INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
        VALUES ${persons.map(p => `(${q(memberOf(p))},${q(league)},${q(season)},${q(espnRow[p.label])},1,${q(etDate(dayOf(p)))},'UTIL',false,now())`).join(',')};`)

    // 2. The real CDN box import of each real final box, on its own day.
    for (const [day, gameId] of boxDays.entries()) {
      const { game } = realBoxes.get(gameId)!
      const id = crypto.randomUUID()
      games.push(id)
      await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
        VALUES(${q(id)},${q(gameId)},${year},1,${q(etDate(day))},clock_timestamp()+interval '${day} days',${q(game.homeTeam.teamTricode)},${q(game.awayTeam.teamTricode)},'Final',
          ${game.homeTeam.score},${game.awayTeam.score},'Final')`)
      const lines = await syncStatsGame({ id, nba_game_id: gameId, season_year: year, week_number: 1, status: 'Final',
        home_score: game.homeTeam.score, away_score: game.awayTeam.score, game_status_text: 'Final' })
      assert.equal(lines, game.homeTeam.players.length + game.awayTeam.players.length, `${label} ${gameId}: every player the real box lists is stored`)
    }
    const afterBoxes = await observe('after the real boxes')

    // 3. The next sync-players, with the pinned index.
    let afterHeal: Stage | null = null, afterNames: Stage | null = null
    if (heal) {
      const second = await refresh('sync 2', indexBody)
      afterHeal = await observe('after sync-players 2 (pinned index)', { sync: { inserted: second.inserted, updated: second.updated, nbaIdsMapped: second.nbaIdsMapped, merged: second.merged } })
      const third = await refresh('sync 3', indexBody)
      afterNames = await observe('after sync-players 3 (pinned index)', { sync: { inserted: third.inserted, updated: third.updated, nbaIdsMapped: third.nbaIdsMapped, merged: third.merged } })
    }
    return { espnRow, afterBoxes, afterHeal, afterNames, stages }
  } finally {
    await sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM private.player_game_memberships WHERE game_id IN (${games.length ? games.map(q) : 'NULL'});
      DELETE FROM player_game_stats WHERE game_id IN (${games.length ? games.map(q) : 'NULL'});
      DELETE FROM nba_games WHERE id IN (${games.length ? games.map(q) : 'NULL'});
      ${year ? `DELETE FROM season_weeks WHERE season_year=${year};` : ''}
      DELETE FROM players WHERE nba_id IN (${people.map(q)}) OR espn_id IN (${persons.map(p => q(p.espn))}) OR espn_id LIKE ${q(`t18-${run}-%`)};
      DELETE FROM profiles WHERE id IN (${user.map(q)});
      DELETE FROM auth.users WHERE id IN (${user.map(q)});
      DELETE FROM sync_runs WHERE function_name='sync-players' AND started_at >= ${q(started)};`)
  }
}

type Row = { id: string; espn_id: string | null; nba_id: string | null; display_name: string; first_name: string; last_name: string }
type Join = { player_id: string; espn_id: string | null; nba_id: string | null; membership: boolean }
type Owned = { player_id: string }
const at = (stage: Stage | null, part: string, p: Person) => (stage as Record<string, Record<string, unknown>>)[part][p.label]
try {
  // Case "pinned index".
  const pinned = await runCase('pinned-index', indexBody, false)
  // Case "index without his row", then the next two syncs with the pinned index.
  const without = await runCase('index-without-row', withoutRows, true)
  console.log(JSON.stringify({ provenance: 'REAL-RAW boxes and player index, SYNTHETIC ESPN listing (names from ESPN summaries), leagues and clocks',
    recipe: 'players-t18-renamed-identity', run, expected }))

  // Pinned index: each listed person is one row from the listing on; his box row joins the owned ESPN row and scores.
  const pinnedListing = pinned.stages[0]
  for (const p of indexed) {
    const listed = at(pinnedListing, 'rows', p) as Row[]
    assert.deepEqual(listed.map(row => [row.espn_id, row.nba_id, row.display_name]), [[p.espn, String(p.person), `${p.first} ${p.last}`]],
      `pinned index, ${p.label}: the index step binds his NBA id to his ESPN row before any box`)
    const rows = at(pinned.afterBoxes, 'rows', p) as Row[]
    assert.deepEqual(rows.map(row => row.id), [pinned.espnRow[p.label]], `pinned index, ${p.label}: still one row after his box`)
    const joins = at(pinned.afterBoxes, 'joins', p) as Join[]
    assert.deepEqual(joins.map(row => [row.player_id, row.membership]), [[pinned.espnRow[p.label], true]], `pinned index, ${p.label}: his box row joins the owned ESPN row`)
    assert.equal(at(pinned.afterBoxes, 'scored', p), expected[p.label], `pinned index, ${p.label}: his fantasy team scores his box`)
  }
  // Cui has no index row: the corroborated BKN listing binds his box to the owned ESPN row, not a name alone.
  const cuiListed = at(pinnedListing, 'rows', cui) as Row[]
  assert.deepEqual(cuiListed.map(row => [row.espn_id, row.nba_id]), [[cui.espn, null]], 'pinned index, Cui: no index row, no NBA id')
  for (const result of [pinned, without]) {
    const rows = at(result.afterBoxes, 'rows', cui) as Row[]
    assert.deepEqual(rows.map(row => [row.id, row.espn_id, row.nba_id, row.display_name]), [[result.espnRow.Cui, cui.espn, String(cui.person), 'Yongxi Cui']],
      'Cui: his box binds his NBA id to the owned ESPN row')
    const joins = at(result.afterBoxes, 'joins', cui) as Join[]
    assert.deepEqual(joins.map(row => [row.player_id, row.membership]), [[result.espnRow.Cui, true]], 'Cui: his box row joins the owned ESPN row')
    assert.equal(at(result.afterBoxes, 'scored', cui), expected.Cui, 'Cui: his fantasy team scores his box')
  }

  // Without his row: the box makes a CDN row of its own; the owned ESPN row scores nothing until the next sync-players.
  for (const p of indexed) {
    const rows = at(without.afterBoxes, 'rows', p) as Row[]
    assert.deepEqual(rows.map(row => [row.espn_id, row.nba_id, row.display_name]), [[p.espn, null, `${p.first} ${p.last}`], [null, String(p.person), p.cdnName]],
      `index without his row, ${p.label}: the ESPN row and a CDN row of its own`)
    const joins = at(without.afterBoxes, 'joins', p) as Join[]
    assert.deepEqual(joins.map(row => [row.espn_id, row.nba_id]), [[null, String(p.person)]], `index without his row, ${p.label}: his box row joins the CDN row`)
    assert.equal(at(without.afterBoxes, 'scored', p), 0, `index without his row, ${p.label}: the owned ESPN row scores nothing`)
    // The next sync-players with the pinned index merges the two into one identity that keeps the box, the ownership and the lineup.
    const healed = at(without.afterHeal, 'rows', p) as Row[]
    assert.equal(healed.length, 1, `index without his row, ${p.label}: one row after the next sync-players`)
    assert.deepEqual([healed[0].espn_id, healed[0].nba_id], [p.espn, String(p.person)], `index without his row, ${p.label}: the row carries both ids`)
    const healedJoins = at(without.afterHeal, 'joins', p) as Join[]
    assert.deepEqual(healedJoins.map(row => [row.player_id, row.membership]), [[healed[0].id, true]], `index without his row, ${p.label}: his box row and membership are on it`)
    assert.deepEqual((at(without.afterHeal, 'owned', p) as Owned[]).map(row => row.player_id), [healed[0].id], `index without his row, ${p.label}: his fantasy team owns it`)
    assert.deepEqual((at(without.afterHeal, 'lined', p) as Owned[]).map(row => row.player_id), [healed[0].id], `index without his row, ${p.label}: his lineup starts it`)
    assert.equal(at(without.afterHeal, 'scored', p), expected[p.label], `index without his row, ${p.label}: his fantasy team scores his box after the merge`)
    const named = at(without.afterNames, 'rows', p) as Row[]
    assert.deepEqual(named.map(row => [row.id, row.display_name]), [[healed[0].id, `${p.first} ${p.last}`]], `index without his row, ${p.label}: the following listing names him as ESPN does`)
  }
  const cuiHealed = at(without.afterNames, 'rows', cui) as Row[]
  assert.deepEqual(cuiHealed.map(row => row.id), [without.espnRow.Cui], 'Cui: still one row after the pinned index, which does not list him')
} finally {
  globalThis.fetch = nativeFetch
  for (const worker of workers) await worker.shutdown()
  await provider.shutdown()
}
