import { strict as assert } from 'node:assert'

// ESPN absence alone must not clear a valid NBA membership. Through the real sync-players, sync-stats
// (syncStatsGame) and lineup-optimizer code against a served synthetic ESPN and NBA CDN origin:
// - Case A, silent omission: X is owned, still on MIN, and listed (inactive, injured) in MIN's stored
//   final box played after ESPN last listed him; refresh 2 answers 200 in every part with all 30 teams
//   and more than 350 athletes, and drops X from MIN's page only. He keeps MIN and keeps starting.
// - Case B, never claimed: W is an owned teamed row ESPN never claimed (no espn_id; team from the
//   product's Sleeper import, nba_id and game membership from the CDN box import), played in MIN's box,
//   and no listing names him. He keeps MIN and keeps starting.
// - R (BOS) is omitted by ESPN and by BOS's later final box, and H (CHI) by ESPN and then by a later CHI
//   box. Box omissions are not proof either (players-t17-real-played-last.ts), so both keep their teams.
//   Z (BOS) is omitted by BOS's box but listed again by refresh 2; when refresh 3 drops him he is held too.
//   Every held row is reported: unproven if ESPN claimed it, unclaimed (W) if not.
// X and W share five PG-eligible starter slots with five playing BOS guards and sort first on ties, so
// each takes a guard's slot while he keeps a team that plays.
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

// The served ESPN origin: 30 teams of 17 synthetic athletes plus X (MIN, day-to-day), five BOS guards,
// R (BOS), H (CHI) and Z (BOS). W is never listed. Every athlete has an NBA person id for the served boxes.
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const run = crypto.randomUUID().slice(0, 8)
let person = 7_000_000 + Math.floor(Math.random() * 1_000_000) * 10
type Athlete = { espn: string; last: string; team: string; person: number; injury?: string }
const athlete = (espn: string, last: string, team: string, injury?: string): Athlete => ({ espn, last, team, person: ++person, injury })
const fillers = codes.flatMap((team, index) => Array.from({ length: 17 }, (_, slot) => athlete(`t15-${run}-${index}-${slot}`, `T15${run}t${index}s${slot}`, team)))
const x = athlete(`t15-${run}-x`, `T15${run}X`, 'MIN', 'Day-To-Day')
const ys = Array.from({ length: 5 }, (_, index) => athlete(`t15-${run}-y${index}`, `T15${run}Y${index}`, 'BOS'))
const r = athlete(`t15-${run}-r`, `T15${run}R`, 'BOS')
const h = athlete(`t15-${run}-h`, `T15${run}H`, 'CHI')
const z = athlete(`t15-${run}-z`, `T15${run}Z`, 'BOS')
const wLast = `T15${run}W`, wPerson = ++person
const on = (team: string) => fillers.filter(filler => filler.team === team)

type BoxPlayer = { personId: number; name: string; played: string; status: string; notPlayingReason?: string; statistics: Record<string, number | string> }
const line = (personId: number, last: string, played: boolean): BoxPlayer => ({
  personId, name: `Synthetic ${last}`, played: played ? '1' : '0', status: played ? 'ACTIVE' : 'INACTIVE',
  ...(played ? {} : { notPlayingReason: 'INACTIVE_INJURY' }),
  statistics: { minutes: played ? 'PT20M00.00S' : 'PT00M00.00S', points: played ? 10 : 0, reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0,
    assists: 0, steals: 0, blocks: 0, turnovers: 0, foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0, threePointersMade: 0,
    threePointersAttempted: 0, freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0 },
})
const boxes = new Map<string, unknown>()

type Feed = { athletes: Athlete[] }
let feed: Feed = { athletes: [] }
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), box = route.match(/^\/cdn\/liveData\/boxscore\/boxscore_(.+)\.json$/)
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map(abbreviation => ({ team: { id: String(codes.indexOf(abbreviation) + 1), abbreviation } })) }] }] })
  if (roster) {
    const team = codes[Number(roster[1]) - 1]
    return Response.json({ athletes: feed.athletes.filter(listed => listed.team === team).map(listed => ({ id: listed.espn, firstName: 'Synthetic', lastName: listed.last,
      fullName: `Synthetic ${listed.last}`, position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 4 } })) })
  }
  if (route === '/site/injuries') {
    return Response.json({ injuries: [{ injuries: feed.athletes.filter(listed => listed.injury).map(listed => ({ status: listed.injury, athlete: { displayName: `Synthetic ${listed.last}` } })) }] })
  }
  if (route === '/site/news') return Response.json({ articles: [] })
  if (route === '/cdn/staticData/playerIndex.json') return Response.json({ resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: [] }] })
  if (box && boxes.has(box[1])) return Response.json({ game: boxes.get(box[1]) })
  if (route.startsWith('/career/')) return Response.json({})
  return new Response('synthetic provider has no such route', { status: 404 })
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
const today = etDate(0), gameDay = etDate(2), pastDay = etDate(-2)
const user = crypto.randomUUID(), league = crypto.randomUUID(), season = crypto.randomUUID(), member = crypto.randomUUID()
const xId = `00000000-0000-4000-8000-1${crypto.randomUUID().slice(-11)}`, wId = `00000000-0000-4000-8000-2${crypto.randomUUID().slice(-11)}`
const yIds = ys.map(() => `8${crypto.randomUUID().slice(1)}`)
const scheduled = crypto.randomUUID(), games: string[] = [scheduled]
const started = new Date().toISOString()
let year = 0
const identity = (id: string) => json<Record<string, unknown> | null>(`SELECT coalesce((SELECT to_jsonb(p) FROM (SELECT id,espn_id,nba_id,sleeper_id,first_name,last_name,
  display_name,position,eligible_positions,status,injury_status,years_exp,nba_draft_number,nba_team FROM players WHERE id=${q(id)}) p),'null')`)
const byEspn = (espn: string) => json<Record<string, unknown> | null>(`SELECT coalesce((SELECT to_jsonb(p) FROM (SELECT id,espn_id,nba_id,display_name,status,injury_status,nba_team FROM players WHERE espn_id=${q(espn)}) p),'null')`)
const ownership = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE player_id=${q(id)}`)
const lineups = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.game_date,l.slot_type),'[]') FROM weekly_lineups l WHERE player_id=${q(id)}`)
const boxRows = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'game_date',g.game_date,'did_not_play',s.did_not_play,
  'member',EXISTS(SELECT 1 FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id)) ORDER BY g.game_date),'[]')
  FROM player_game_stats s JOIN nba_games g ON g.id=s.game_id WHERE s.player_id=${q(id)}`)
const starters = () => json<{ player_id: string; slot_type: string; is_auto_set: boolean }[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('player_id',player_id,'slot_type',slot_type,'is_auto_set',is_auto_set) ORDER BY slot_type),'[]')
  FROM weekly_lineups WHERE member_id=${q(member)} AND game_date=${q(gameDay)} AND slot_type NOT IN ('BE','IR')`)
const observations: Record<string, unknown>[] = []
try {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: a refresh may release any teamed player it does not list')
  year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
  assert.ok(year)
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${q(user)},${q(user + '@example.test')},jsonb_build_object('username',${q(user)}));
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id,nba_id)
      VALUES(${q(xId)},'Synthetic',${q(x.last)},'PG',ARRAY['PG'],'Active','MIN',4,${q(x.espn)},${q(String(x.person))}),
            ${ys.map((guard, index) => `(${q(yIds[index])},'Synthetic',${q(guard.last)},'PG',ARRAY['PG'],'Active','BOS',4,${q(guard.espn)},${q(String(guard.person))})`).join(',')};
    INSERT INTO leagues(id,slug,name,commissioner_id,status) VALUES(${q(league)},${q('t15-omission-' + run)},'Synthetic silent omission',${q(user)},'active');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(user)},'commissioner','Silent omission');
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,${q(etDate(-3))},${q(etDate(3))});
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES(${q(scheduled)},${q(`002t15${run}s`)},${year},1,${q(gameDay)},${q(gameDay + 'T23:00:00Z')},'MIN','BOS','Scheduled');
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      SELECT ${q(league)},${q(season)},${q(member)},id,'draft' FROM unnest(ARRAY[${[xId, ...yIds].map(q)}]::uuid[]) id;
    INSERT INTO lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES(${q(league)},${q(season)},${q(member)},true)
      ON CONFLICT (league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
    INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
      VALUES(${q(member)},${q(league)},${q(season)},${q(xId)},1,${q(pastDay)},'PG',false,now());`)
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const optimizer = await serve(() => import('../../functions/lineup-optimizer/index.ts'))
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
  const refresh = async (label: string, athletes: Athlete[]) => {
    feed = { athletes }
    const response = await invoke(sync)
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.ok, true, `${label}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  const optimize = async (label: string) => {
    const response = await invoke(optimizer, { date: gameDay })
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.failed, 0, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.optimized, 1, `${label}: the owned member is optimized for ${gameDay}`)
    return await starters()
  }
  // A final game played now (after every listing so far), stored through the real CDN box import.
  const finalBox = async (home: string, away: string, homeLines: BoxPlayer[], awayLines: BoxPlayer[]) => {
    const id = crypto.randomUUID(), providerId = `002t15${run}${games.length}`
    games.push(id)
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
      VALUES(${q(id)},${q(providerId)},${year},1,${q(today)},clock_timestamp(),${q(home)},${q(away)},'Final',100,90,'Final')`)
    boxes.set(providerId, { gameId: providerId, gameStatus: 3, gameStatusText: 'Final', homeTeam: { teamTricode: home, score: 100, players: homeLines },
      awayTeam: { teamTricode: away, score: 90, players: awayLines } })
    const lines = await syncStatsGame({ id, nba_game_id: providerId, season_year: year, week_number: 1, status: 'Final', home_score: 100, away_score: 90, game_status_text: 'Final' })
    assert.equal(lines, homeLines.length + awayLines.length)
    assert.ok(await sql(`SELECT stats_synced_at IS NOT NULL FROM nba_games WHERE id=${q(id)}`) === 't', `${home}-${away}: the complete final box is stored`)
    return providerId
  }
  const played = (listed: Athlete) => line(listed.person, listed.last, true)
  const startedOn = (rows: { player_id: string }[], id: string) => rows.some(row => row.player_id === id)
  const guardsStarted = (rows: { player_id: string }[]) => yIds.filter(id => startedOn(rows, id)).length

  // Refresh 1 lists X on MIN, R and Z on BOS and H on CHI.
  await refresh('refresh 1', [...fillers, x, ...ys, r, h, z])
  // W: a teamed row ESPN never claimed. The CDN import creates bare rows (names only); the product's Sleeper
  // import gives this one his team; MIN's final box below gives him his nba_id and game membership.
  await sql(`INSERT INTO players(id,first_name,last_name) VALUES(${q(wId)},'Synthetic',${q(wLast)});`)
  const claimed = await json<{ results: { player_id: string; action: string }[] }>(`SELECT resolve_player_imports_atomic('sleeper',${q(JSON.stringify([{ provider_id: `t15-${run}-sleeper-w`,
    first_name: 'Synthetic', last_name: wLast, metadata: { nba_team: 'MIN', position: 'PG', eligible_positions: ['PG'], status: 'Active', injury_status: null, years_exp: 3 } }]))}::jsonb)`)
  assert.deepEqual(claimed.results.map(result => [result.player_id, result.action]), [[wId, 'updated']])
  await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${q(league)},${q(season)},${q(member)},${q(wId)},'draft');`)

  // MIN's final box lists X (inactive, injured) and W (played); BOS's side lists its guards but not R or Z.
  const minBox = await finalBox('MIN', 'BOS', [...on('MIN').map(played), line(x.person, x.last, false), line(wPerson, wLast, true)], [...on('BOS').map(played), ...ys.map(played)])
  const xBox = await boxRows(xId), wBox = await boxRows(wId)
  assert.deepEqual(xBox, [{ game: minBox, game_date: today, did_not_play: true, member: true }], 'The stored box keeps X as an inactive listing')
  assert.deepEqual(wBox, [{ game: minBox, game_date: today, did_not_play: false, member: true }])
  const xBefore = await identity(xId), wBefore = await identity(wId)
  assert.ok(xBefore && wBefore)
  assert.equal(xBefore.nba_team, 'MIN')
  assert.equal(xBefore.injury_status, 'DTD')
  assert.deepEqual({ espn: wBefore.espn_id, nba: wBefore.nba_id, team: wBefore.nba_team }, { espn: null, nba: String(wPerson), team: 'MIN' }, 'W is teamed, NBA-identified and never claimed by ESPN')
  assert.equal((await byEspn(r.espn))?.nba_team, 'BOS')
  assert.equal((await byEspn(h.espn))?.nba_team, 'CHI')
  assert.equal((await byEspn(z.espn))?.nba_team, 'BOS')
  const firstStarters = await optimize('optimizer before refresh 2')
  assert.ok(startedOn(firstStarters, xId) && startedOn(firstStarters, wId), `X and W start on MIN's game day ${gameDay}: ${JSON.stringify(firstStarters)}`)
  assert.equal(guardsStarted(firstStarters), 3)
  const xOwned = await ownership(xId), wOwned = await ownership(wId), xLined = await lineups(xId), wLined = await lineups(wId)
  observations.push({ case: 'before-refresh-2', x: xBefore, w: wBefore, xBox, wBox, starters: firstStarters })

  // Refresh 2: HTTP 200 in every part, all 30 teams, more than 350 athletes. It drops X from MIN's page
  // only (silent omission), R (BOS's later box omits him too) and H (no CHI box since). W is never named.
  // Z, whom BOS's box omitted, is listed again.
  const listed2 = [...fillers, ...ys]
  assert.ok(listed2.length > 350)
  const second = await refresh('refresh 2', [...listed2, z])
  const xAfter = await identity(xId), wAfter = await identity(wId), rAfter = await byEspn(r.espn), hAfter = await byEspn(h.espn)
  const xOwnedAfter = await ownership(xId), wOwnedAfter = await ownership(wId), xLinedAfter = await lineups(xId), wLinedAfter = await lineups(wId)
  const secondStarters = await optimize('optimizer after refresh 2')
  observations.push({ case: 'refresh-2-silent-omission', released: second.released ?? null, releaseHeld: second.releaseHeld ?? null,
    caseA: { x: xAfter, roster: xOwnedAfter, lineupsBeforeOptimizer: xLinedAfter, autoStarted: startedOn(secondStarters, xId) },
    caseB: { w: wAfter, roster: wOwnedAfter, lineupsBeforeOptimizer: wLinedAfter, autoStarted: startedOn(secondStarters, wId) },
    r: rAfter, h: hAfter, starters: secondStarters, playingGuardsStarted: guardsStarted(secondStarters) })
  console.log(JSON.stringify(observations.at(-1)))
  assert.deepEqual(xAfter, xBefore, 'Case A: a silently omitted player whose team\'s latest stored box lists him keeps his row and his team')
  assert.deepEqual(xOwnedAfter, xOwned, 'Case A: ownership is unchanged')
  assert.deepEqual(xLinedAfter, xLined, 'Case A: lineups are unchanged')
  assert.deepEqual(wAfter, wBefore, 'Case B: a teamed row ESPN never claimed keeps its row and its team')
  assert.deepEqual(wOwnedAfter, wOwned, 'Case B: ownership is unchanged')
  assert.deepEqual(wLinedAfter, wLined, 'Case B: lineups are unchanged')
  assert.ok(startedOn(secondStarters, xId) && startedOn(secondStarters, wId), `X and W still start on MIN's game day: ${JSON.stringify(secondStarters)}`)
  assert.equal(guardsStarted(secondStarters), 3)
  assert.equal(rAfter?.nba_team, 'BOS', 'R, omitted by ESPN and by his team\'s later box, keeps his team: neither proves he left')
  assert.equal(hAfter?.nba_team, 'CHI', 'H, omitted by ESPN with no CHI box since, keeps his team')
  assert.equal((await byEspn(z.espn))?.nba_team, 'BOS', 'Z, listed again, keeps BOS')
  assert.equal(second.released, 0)
  assert.deepEqual(second.releaseHeld, { unproven: 3, unclaimed: 1 }, 'X, R and H are held as unproven; W, never claimed, as unclaimed')

  // A CHI final box without H arrives; the next refresh still omits him and still holds him. X, R and W stay
  // held, and so does Z, whom refresh 3 drops.
  await finalBox('CHI', 'ATL', on('CHI').map(played), on('ATL').map(played))
  const third = await refresh('refresh 3', listed2)
  const hThird = await byEspn(h.espn), zThird = await byEspn(z.espn)
  observations.push({ case: 'refresh-3-after-chi-box', released: third.released ?? null, releaseHeld: third.releaseHeld ?? null, h: hThird, z: zThird, x: await identity(xId), w: await identity(wId) })
  assert.deepEqual(hThird, hAfter, 'H keeps CHI, his row, ids, injury and status after a CHI box played after his last listing omits him')
  assert.deepEqual(await identity(xId), xBefore)
  assert.deepEqual(await identity(wId), wBefore)
  assert.equal((await byEspn(r.espn))?.nba_team, 'BOS', 'R still keeps BOS')
  assert.equal(zThird?.nba_team, 'BOS', 'Z keeps BOS')
  assert.equal(third.released, 0)
  assert.deepEqual(third.releaseHeld, { unproven: 4, unclaimed: 1 }, 'X, R, H and Z are held as unproven; W as unclaimed')
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe: 'players-t15-silent-omission', run, gameDay, today, observations }))
} finally {
  try {
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    await sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM player_game_stats WHERE game_id IN (${games.map(q)});
      DELETE FROM nba_games WHERE id IN (${games.map(q)});
      ${year ? `DELETE FROM season_weeks WHERE season_year=${year};` : ''}
      DELETE FROM players WHERE id IN (${[xId, wId, ...yIds].map(q)}) OR espn_id LIKE ${q(`t15-${run}-%`)};
      DELETE FROM profiles WHERE id=${q(user)};
      DELETE FROM auth.users WHERE id=${q(user)};
      DELETE FROM sync_runs WHERE function_name IN ('sync-players','lineup-optimizer') AND started_at >= ${q(started)};`)
  }
}
