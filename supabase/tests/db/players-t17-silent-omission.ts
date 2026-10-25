import { strict as assert } from 'node:assert'

// A complete-looking ESPN refresh that silently omits a claimed player is not proof that he left, whatever
// the stored boxes show before it. Through the real sync-players, sync-stats (syncStatsGame), lineup-optimizer
// and scoring code against a served synthetic ESPN and NBA CDN origin; refresh 2 answers 200 in every part,
// lists all 30 teams and more than 350 athletes, and fails no import:
// - X (MIN), played last: MIN's box of yesterday lists him playing, MIN's box played after refresh 1 omits him,
//   and refresh 2 drops him from MIN's page only.
// - N (BOS), never listed: no stored box has ever listed him; BOS's box after refresh 1 omits him and refresh 2
//   drops him too.
// Both are held as unproven: team, row, ids, injury and status, ownership and lineups stay, the optimizer keeps
// starting them on their teams' game day, and that game's box rows score for their fantasy team.
// - Control, R: refresh 2 lists him on CHI, positive dated evidence of a move, so his row is re-teamed.
// - Control, D (ATL): MIN-BOS's box, played after refresh 1, lists him for BOS, a game ATL did not play, and
//   refresh 2 drops him: positive dated evidence that he left ATL, so his team alone moves to BOS, the side
//   that box lists him under, and is reported as released. Refresh 3 lists him on BOS and keeps his new team.
// X and N share five PG-eligible starter slots with five playing BOS guards and sort first on ties, so each
// takes a guard's slot while he keeps a team that plays.
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
const originPort = Number(`${apiPort.slice(0, 3)}86`)

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

// The served ESPN origin: 30 teams of 17 synthetic athletes plus X (MIN, day-to-day), N (BOS), five BOS
// guards, R (BOS) and D (ATL). Every athlete has an NBA person id for the served boxes.
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const run = crypto.randomUUID().slice(0, 8)
let person = 7_000_000 + Math.floor(Math.random() * 1_000_000) * 10
type Athlete = { espn: string; last: string; team: string; person: number; injury?: string }
const athlete = (espn: string, last: string, team: string, injury?: string): Athlete => ({ espn, last, team, person: ++person, injury })
const fillers = codes.flatMap((team, index) => Array.from({ length: 17 }, (_, slot) => athlete(`t17-${run}-${index}-${slot}`, `T17${run}t${index}s${slot}`, team)))
const x = athlete(`t17-${run}-x`, `T17${run}X`, 'MIN', 'Day-To-Day')
const n = athlete(`t17-${run}-n`, `T17${run}N`, 'BOS')
const ys = Array.from({ length: 5 }, (_, index) => athlete(`t17-${run}-y${index}`, `T17${run}Y${index}`, 'BOS'))
const r = athlete(`t17-${run}-r`, `T17${run}R`, 'BOS')
const d = athlete(`t17-${run}-d`, `T17${run}D`, 'ATL')
const on = (team: string) => fillers.filter(filler => filler.team === team)

type BoxPlayer = { personId: number; name: string; played: string; status: string; statistics: Record<string, number | string> }
const line = (personId: number, last: string, points: number): BoxPlayer => ({
  personId, name: `Synthetic ${last}`, played: '1', status: 'ACTIVE',
  statistics: { minutes: 'PT20M00.00S', points, reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0,
    assists: 0, steals: 0, blocks: 0, turnovers: 0, foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0, threePointersMade: 0,
    threePointersAttempted: 0, freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0 },
})
const boxes = new Map<string, unknown>()

let feed: Athlete[] = []
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), box = route.match(/^\/cdn\/liveData\/boxscore\/boxscore_(.+)\.json$/)
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: codes.map(abbreviation => ({ team: { id: String(codes.indexOf(abbreviation) + 1), abbreviation } })) }] }] })
  if (roster) {
    const team = codes[Number(roster[1]) - 1]
    return Response.json({ athletes: feed.filter(listed => listed.team === team).map(listed => ({ id: listed.espn, firstName: 'Synthetic', lastName: listed.last,
      fullName: `Synthetic ${listed.last}`, position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 4 } })) })
  }
  if (route === '/site/injuries') {
    return Response.json({ injuries: [{ injuries: feed.filter(listed => listed.injury).map(listed => ({ status: listed.injury, athlete: { displayName: `Synthetic ${listed.last}` } })) }] })
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
const xId = `00000000-0000-4000-8000-1${crypto.randomUUID().slice(-11)}`, nId = `00000000-0000-4000-8000-2${crypto.randomUUID().slice(-11)}`
const yIds = ys.map(() => `8${crypto.randomUUID().slice(1)}`), dId = crypto.randomUUID()
const scheduled = crypto.randomUUID(), scheduledGame = `002t17${run}s`, games: string[] = [scheduled]
const started = new Date().toISOString()
let year = 0
const identity = (id: string) => json<Record<string, unknown> | null>(`SELECT coalesce((SELECT to_jsonb(p) FROM (SELECT id,espn_id,nba_id,sleeper_id,first_name,last_name,
  display_name,position,eligible_positions,status,injury_status,years_exp,nba_draft_number,nba_team FROM players WHERE id=${q(id)}) p),'null')`)
const byEspn = (espn: string) => json<Record<string, unknown> | null>(`SELECT coalesce((SELECT to_jsonb(p) FROM (SELECT id,espn_id,nba_id,display_name,status,injury_status,nba_team FROM players WHERE espn_id=${q(espn)}) p),'null')`)
const ownership = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE player_id=${q(id)}`)
const lineups = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.game_date,l.slot_type),'[]') FROM weekly_lineups l WHERE player_id=${q(id)}`)
const boxRows = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('game',g.nba_game_id,'game_date',g.game_date,'did_not_play',s.did_not_play,
  'member',EXISTS(SELECT 1 FROM private.player_game_memberships m WHERE m.player_id=s.player_id AND m.game_id=s.game_id)) ORDER BY g.game_date,g.game_time),'[]')
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
            (${q(nId)},'Synthetic',${q(n.last)},'PG',ARRAY['PG'],'Active','BOS',4,${q(n.espn)},${q(String(n.person))}),
            ${ys.map((guard, index) => `(${q(yIds[index])},'Synthetic',${q(guard.last)},'PG',ARRAY['PG'],'Active','BOS',4,${q(guard.espn)},${q(String(guard.person))})`).join(',')},
            (${q(dId)},'Synthetic',${q(d.last)},'PG',ARRAY['PG'],'Active','ATL',4,${q(d.espn)},${q(String(d.person))});
    INSERT INTO leagues(id,slug,name,commissioner_id,status) VALUES(${q(league)},${q('t17-omission-' + run)},'Synthetic silent omission',${q(user)},'active');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(user)},'commissioner','Silent omission');
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,${q(etDate(-3))},${q(etDate(3))});
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES(${q(scheduled)},${q(scheduledGame)},${year},1,${q(gameDay)},${q(gameDay + 'T23:00:00Z')},'MIN','BOS','Scheduled');
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      SELECT ${q(league)},${q(season)},${q(member)},id,'draft' FROM unnest(ARRAY[${[xId, nId, ...yIds].map(q)}]::uuid[]) id;
    INSERT INTO player_projections(player_id,season_year,week_number,projected_stat_points)
      SELECT id,${year},1,10 FROM unnest(ARRAY[${[xId, nId, ...yIds].map(q)}]::uuid[]) id;
    INSERT INTO lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES(${q(league)},${q(season)},${q(member)},true)
      ON CONFLICT (league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
    INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
      VALUES(${q(member)},${q(league)},${q(season)},${q(xId)},1,${q(pastDay)},'PG',false,now()),
            (${q(member)},${q(league)},${q(season)},${q(nId)},1,${q(pastDay)},'BE',false,now());`)
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const optimizer = await serve(() => import('../../functions/lineup-optimizer/index.ts'))
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
  const { calcWeekPointsByMember } = await import('../../functions/_shared/scoreLineups.ts')
  const refresh = async (label: string, athletes: Athlete[]) => {
    feed = athletes
    const response = await invoke(sync)
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.ok, true, `${label}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  const optimize = async (label: string) => {
    const projections = await json<{ player_id: string; projection_source: string; projection_fantasy_points: number }[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('player_id',player_id,'projection_source',projection_source,
      'projection_fantasy_points',projection_fantasy_points) ORDER BY player_id),'[]')
      FROM get_league_projection_rows(p_league_id=>${q(league)},p_season_year=>${year},p_game_date=>${q(gameDay)},p_view=>'today',
        p_player_ids=>ARRAY[${[xId, nId, ...yIds].map(q)}]::uuid[],p_limit=>${yIds.length + 2},p_offset=>0)`)
    assert.equal(projections.length, yIds.length + 2, `${label}: every rostered player has a projection`)
    assert.ok(projections.every(row => row.projection_source === 'internal' && row.projection_fantasy_points === 10), `${label}: projections tie before player IDs break the tie`)
    observations.push({ case: 'optimizer-projection-inputs', label, projections })
    const response = await invoke(optimizer, { date: gameDay })
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.failed, 0, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.optimized, 1, `${label}: the owned member is optimized for ${gameDay}`)
    return await starters()
  }
  // A final box stored through the real CDN box import: a new game played now (after every listing so far) or
  // `day` days from now, or the scheduled game once it is final.
  const storeBox = async (id: string, providerId: string, home: string, away: string, homeLines: BoxPlayer[], awayLines: BoxPlayer[]) => {
    boxes.set(providerId, { gameId: providerId, gameStatus: 3, gameStatusText: 'Final', homeTeam: { teamTricode: home, score: 100, players: homeLines },
      awayTeam: { teamTricode: away, score: 90, players: awayLines } })
    const lines = await syncStatsGame({ id, nba_game_id: providerId, season_year: year, week_number: 1, status: 'Final', home_score: 100, away_score: 90, game_status_text: 'Final' })
    assert.equal(lines, homeLines.length + awayLines.length)
    assert.equal(await sql(`SELECT stats_synced_at IS NOT NULL FROM nba_games WHERE id=${q(id)}`), 't', `${home}-${away}: the complete final box is stored`)
    return providerId
  }
  const finalBox = async (home: string, away: string, homeLines: BoxPlayer[], awayLines: BoxPlayer[], day = 0) => {
    const id = crypto.randomUUID(), providerId = `002t17${run}${games.length}`
    games.push(id)
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
      VALUES(${q(id)},${q(providerId)},${year},1,${q(etDate(day))},clock_timestamp()+interval '${day} days',${q(home)},${q(away)},'Final',100,90,'Final')`)
    return await storeBox(id, providerId, home, away, homeLines, awayLines)
  }
  const played = (listed: Athlete, points = 10) => line(listed.person, listed.last, points)
  const startedOn = (rows: { player_id: string }[], id: string) => rows.some(row => row.player_id === id)
  const guardsStarted = (rows: { player_id: string }[]) => yIds.filter(id => startedOn(rows, id)).length

  // Refresh 1 lists X on MIN, N, R and the guards on BOS, and D on ATL.
  await refresh('refresh 1', [...fillers, x, n, ...ys, r, d])
  // MIN-ATL yesterday: MIN lists X playing. MIN-BOS now: MIN omits X; BOS lists its guards and D but not N (or R).
  const firstBox = await finalBox('MIN', 'ATL', [...on('MIN').map(listed => played(listed)), played(x)], on('ATL').map(listed => played(listed)), -1)
  const otherBox = await finalBox('MIN', 'BOS', on('MIN').map(listed => played(listed)), [...on('BOS').map(listed => played(listed)), ...ys.map(listed => played(listed)), played(d)])
  const xBox = await boxRows(xId), nBox = await boxRows(nId), dBox = await boxRows(dId)
  assert.deepEqual(xBox, [{ game: firstBox, game_date: etDate(-1), did_not_play: false, member: true }], 'X\'s last stored listing shows him playing; MIN\'s next box omits him')
  assert.deepEqual(nBox, [], 'No stored box has ever listed N')
  assert.deepEqual(dBox, [{ game: otherBox, game_date: today, did_not_play: false, member: true }], 'D is listed in a game ATL did not play')
  const xBefore = (await identity(xId))!, nBefore = (await identity(nId))!, rBefore = (await byEspn(r.espn))!, dBefore = (await identity(dId))!
  assert.deepEqual([xBefore.nba_team, xBefore.injury_status, nBefore.nba_team, rBefore.nba_team, dBefore.nba_team], ['MIN', 'DTD', 'BOS', 'BOS', 'ATL'])
  assert.equal(await sql(`SELECT nba_team || ' ' || (listed_at < (SELECT game_time FROM nba_games WHERE nba_game_id=${q(otherBox)})) FROM private.player_espn_listings WHERE player_id=${q(dId)}`),
    'ATL true', 'ESPN last listed D on ATL before MIN-BOS tipped off')
  const firstStarters = await optimize('optimizer before refresh 2')
  assert.ok(startedOn(firstStarters, xId) && startedOn(firstStarters, nId), `X and N start on their teams' game day ${gameDay}: ${JSON.stringify(firstStarters)}`)
  assert.equal(guardsStarted(firstStarters), 3)
  const xOwned = await ownership(xId), nOwned = await ownership(nId), xLined = await lineups(xId), nLined = await lineups(nId)
  observations.push({ case: 'before-refresh-2', x: xBefore, n: nBefore, r: rBefore, xBox, nBox, starters: firstStarters })

  // Refresh 2: HTTP 200 in every part, all 30 teams, more than 350 athletes, no import failure. It drops X,
  // N and D and lists R on CHI.
  const listed2 = [...fillers, ...ys, { ...r, team: 'CHI' }]
  assert.ok(listed2.length > 350)
  const second = await refresh('refresh 2', listed2)
  const xAfter = await identity(xId), nAfter = await identity(nId), rAfter = await byEspn(r.espn), dAfter = await identity(dId)
  const xOwnedAfter = await ownership(xId), nOwnedAfter = await ownership(nId), xLinedAfter = await lineups(xId), nLinedAfter = await lineups(nId)
  const secondStarters = await optimize('optimizer after refresh 2')
  observations.push({ case: 'refresh-2-silent-omission', released: second.released ?? null, releaseHeld: second.releaseHeld ?? null, releaseSkipped: second.releaseSkipped ?? null,
    x: { row: xAfter, roster: xOwnedAfter, lineupsBeforeOptimizer: xLinedAfter, autoStarted: startedOn(secondStarters, xId) },
    n: { row: nAfter, roster: nOwnedAfter, lineupsBeforeOptimizer: nLinedAfter, autoStarted: startedOn(secondStarters, nId) },
    r: rAfter, d: dAfter, starters: secondStarters, playingGuardsStarted: guardsStarted(secondStarters) })
  console.log(JSON.stringify(observations.at(-1)))
  assert.deepEqual(second.releaseSkipped, [], 'Refresh 2 is complete: nothing blocks the sweep')
  assert.deepEqual(xAfter, xBefore, 'X: a silent omission after a box that shows him playing keeps his row, injury and team')
  assert.deepEqual(nAfter, nBefore, 'N: a silent omission of a player no stored box has listed keeps his row and team')
  assert.deepEqual([xOwnedAfter, nOwnedAfter], [xOwned, nOwned], 'Ownership is unchanged')
  assert.deepEqual([xLinedAfter, nLinedAfter], [xLined, nLined], 'Lineups are unchanged')
  assert.deepEqual(rAfter, { ...rBefore, nba_team: 'CHI' }, 'R: a listing on CHI is positive evidence, so the same row moves to CHI')
  assert.deepEqual(dAfter, { ...dBefore, nba_team: 'BOS' }, 'D: a box of a game ATL did not play, after his last ATL listing, moves his team alone to the side it lists him under')
  assert.equal(second.released, 1, 'Only D, on positive evidence, is released')
  assert.deepEqual(second.releaseHeld, { unproven: 2, unclaimed: 0 }, 'X and N are reported as held, unproven')
  assert.ok(startedOn(secondStarters, xId) && startedOn(secondStarters, nId), `X and N still start on their teams' game day: ${JSON.stringify(secondStarters)}`)
  assert.equal(guardsStarted(secondStarters), 3)

  // The MIN-BOS game of that day goes final and lists X and N playing: those rows score for their fantasy team.
  await sql(`UPDATE nba_games SET status='Final',home_score=100,away_score=90,game_status_text='Final' WHERE id=${q(scheduled)}`)
  const points: Record<string, number> = { [xId]: 12, [nId]: 7, ...Object.fromEntries(yIds.map((id, index) => [id, 3 + index])) }
  await storeBox(scheduled, scheduledGame, 'MIN', 'BOS', [...on('MIN').map(listed => played(listed)), played(x, points[xId])],
    [...on('BOS').map(listed => played(listed)), played(n, points[nId]), ...ys.map((listed, index) => played(listed, points[yIds[index]]))])
  assert.equal((await boxRows(xId)).length, 2, 'X has his earlier box row and this one')
  assert.deepEqual(await boxRows(nId), [{ game: scheduledGame, game_date: gameDay, did_not_play: false, member: true }])
  const expected = secondStarters.reduce((sum, row) => sum + (points[row.player_id] ?? 0), 0)
  const scored = (await calcWeekPointsByMember([member], season, year, 1, { points: 1 }, etDate(-3), etDate(3))).get(member)
  observations.push({ case: 'scoring', expected, scored })
  assert.ok(expected >= points[xId] + points[nId])
  assert.equal(scored, expected, 'The starters\' box rows on that day, X and N included, score for the fantasy team')

  // Refresh 3 lists X and N again on their teams, R on CHI and D on BOS: D takes BOS, nothing else changes.
  const third = await refresh('refresh 3', [...listed2, x, n, { ...d, team: 'BOS' }])
  observations.push({ case: 'refresh-3', released: third.released ?? null, releaseHeld: third.releaseHeld ?? null, x: await identity(xId), n: await identity(nId), r: await byEspn(r.espn),
    d: await identity(dId) })
  assert.deepEqual(await identity(xId), xBefore)
  assert.deepEqual(await identity(nId), nBefore)
  assert.deepEqual(await byEspn(r.espn), { ...rBefore, nba_team: 'CHI' })
  assert.deepEqual(await identity(dId), { ...dBefore, nba_team: 'BOS' }, 'D: the listing on BOS keeps his new team on the same row')
  assert.equal(third.released, 0)
  assert.deepEqual(third.releaseHeld, { unproven: 0, unclaimed: 0 })
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe: 'players-t17-silent-omission', run, gameDay, today, observations }))
} finally {
  try {
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    await sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM private.player_game_memberships WHERE game_id IN (${games.map(q)});
      DELETE FROM player_game_stats WHERE game_id IN (${games.map(q)});
      DELETE FROM nba_games WHERE id IN (${games.map(q)});
      DELETE FROM player_projections WHERE season_year=${year} AND player_id IN (${[xId, nId, ...yIds].map(q)});
      ${year ? `DELETE FROM season_weeks WHERE season_year=${year};` : ''}
      DELETE FROM players WHERE id IN (${[xId, nId, dId, ...yIds].map(q)}) OR espn_id LIKE ${q(`t17-${run}-%`)}
        OR nba_id IN (${[...fillers, x, n, ...ys, r, d].map(listed => q(String(listed.person)))});
      DELETE FROM profiles WHERE id=${q(user)};
      DELETE FROM auth.users WHERE id=${q(user)};
      DELETE FROM sync_runs WHERE function_name IN ('sync-players','lineup-optimizer') AND started_at >= ${q(started)};`)
  }
}
