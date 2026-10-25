import { strict as assert } from 'node:assert'

// A player absent from every roster of a complete ESPN refresh, through the real sync-players, sync-stats
// (syncStatsGame) and lineup-optimizer code against a served synthetic ESPN and NBA CDN origin. Refresh 1
// lists X on MIN; MIN then plays a final game whose stored box omits him. Neither omission proves he left
// (players-t17-silent-omission.ts), so a complete refresh without X holds him: he keeps MIN, his row, ids,
// injury, ownership and lineups, the optimizer keeps starting him on MIN game days, and the run reports
// him as held (unproven). A later listing on BOS, positive evidence of a move, re-teams the same row. An
// incomplete or failed refresh (a team missing, a roster error, a failed import chunk)
// skips the sweep and says why. Those that reach the career-games step rewrite his row after the box, so
// nothing may date his last listing by players.updated_at. X shares five PG-eligible starter slots with
// five playing BOS guards and sorts first on ties, so while he keeps a team that plays he takes a slot
// from one of them.
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
const originPort = Number(`${apiPort.slice(0, 3)}84`)

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

// The served ESPN origin: 30 teams of 17 synthetic athletes plus X (MIN, day-to-day) and five BOS guards.
const codes = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']
const run = crypto.randomUUID().slice(0, 8)
type Athlete = { espn: string; last: string; team: string; injury?: string }
const fillers: Athlete[] = codes.flatMap((team, index) => Array.from({ length: 17 }, (_, slot) => ({ espn: `t14-${run}-${index}-${slot}`, last: `T14${run}t${index}s${slot}`, team })))
fillers[0].injury = 'Out'
const x: Athlete = { espn: `t14-${run}-x`, last: `T14${run}X`, team: 'MIN', injury: 'Day-To-Day' }
const ys: Athlete[] = Array.from({ length: 5 }, (_, index) => ({ espn: `t14-${run}-y${index}`, last: `T14${run}Y${index}`, team: 'BOS' }))
type Feed = { athletes: Athlete[]; teams?: string[]; failRoster?: string; failInjuries?: boolean; blankName?: boolean }
let feed: Feed = { athletes: [...fillers, x, ...ys] }
const boxes = new Map<string, unknown>()
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const route = new URL(request.url).pathname
  const roster = route.match(/^\/site\/teams\/(\d+)\/roster$/), box = route.match(/^\/cdn\/liveData\/boxscore\/boxscore_(.+)\.json$/)
  const teams = feed.teams ?? codes
  if (route === '/site/teams') return Response.json({ sports: [{ leagues: [{ teams: teams.map(abbreviation => ({ team: { id: String(codes.indexOf(abbreviation) + 1), abbreviation } })) }] }] })
  if (roster) {
    const team = codes[Number(roster[1]) - 1]
    if (team === feed.failRoster) return new Response('synthetic roster outage', { status: 503 })
    const athletes = feed.athletes.filter(athlete => athlete.team === team).map(athlete => ({ id: athlete.espn, firstName: 'Synthetic', lastName: athlete.last,
      fullName: `Synthetic ${athlete.last}`, position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 4 } }))
    if (feed.blankName && team === 'ATL') athletes.push({ id: `t14-${run}-blank`, firstName: ' ', lastName: ' ', fullName: ' ', position: { abbreviation: 'PG' }, status: { type: 'active' }, experience: { years: 1 } })
    return Response.json({ athletes })
  }
  if (route === '/site/injuries') {
    if (feed.failInjuries) return new Response('synthetic injuries outage', { status: 503 })
    return Response.json({ injuries: [{ injuries: feed.athletes.filter(athlete => athlete.injury).map(athlete => ({ status: athlete.injury, athlete: { displayName: `Synthetic ${athlete.last}` } })) }] })
  }
  if (route === '/site/news') return Response.json({ articles: [] })
  if (route === '/cdn/staticData/playerIndex.json') return Response.json({ resultSets: [{ headers: ['PERSON_ID', 'PLAYER_FIRST_NAME', 'PLAYER_LAST_NAME', 'ROSTER_STATUS'], rowSet: [] }] })
  if (box && boxes.has(box[1])) return Response.json({ game: boxes.get(box[1]) })
  if (/^\/career\/athletes\/[^/]+\/stats$/.test(route)) return Response.json({
    filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }],
    categories: [{ names: ['gamesPlayed'], totals: ['120'] }],
  })
  return new Response('synthetic provider has no such route', { status: 404 })
})
const origin = `http://127.0.0.1:${originPort}`
Deno.env.set('PLAYER_SYNC_SOURCE', 'espn')
Deno.env.set('ESPN_SITE_BASE_URL', `${origin}/site`)
Deno.env.set('ESPN_CAREER_BASE_URL', `${origin}/career`)
Deno.env.set('NBA_CDN_BASE_URL', `${origin}/cdn`)
Deno.env.set('SLEEPER_BASE_URL', `${origin}/sleeper`)

// Both handlers run in this process; every request must stay on this stack, the origin or a handler.
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

const etDate = (offset: number) => {
  const day = new Date(Date.now() + offset * 86_400_000)
  return day.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
const today = etDate(0), gameDay = etDate(2), pastDay = etDate(-2)
const user = crypto.randomUUID(), league = crypto.randomUUID(), season = crypto.randomUUID(), member = crypto.randomUUID()
const xId = `00000000-0000-4000-8000-${crypto.randomUUID().slice(-12)}`, game = crypto.randomUUID(), final = crypto.randomUUID(), prior = crypto.randomUUID()
const yIds = ys.map(() => `8${crypto.randomUUID().slice(1)}`)
const started = new Date().toISOString()
let year = 0
const identity = (id: string) => json<Record<string, unknown> | null>(`SELECT coalesce((SELECT to_jsonb(p) FROM (SELECT id,espn_id,nba_id,sleeper_id,first_name,last_name,
  display_name,position,eligible_positions,status,injury_status,years_exp,nba_draft_number,nba_team FROM players WHERE id=${q(id)}) p),'null')`)
const ownership = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM roster_players r WHERE player_id=${q(id)}`)
const lineups = (id: string) => json<unknown[]>(`SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.game_date,l.slot_type),'[]') FROM weekly_lineups l WHERE player_id=${q(id)}`)
const starters = () => json<{ player_id: string; slot_type: string; is_auto_set: boolean }[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('player_id',player_id,'slot_type',slot_type,'is_auto_set',is_auto_set) ORDER BY slot_type),'[]')
  FROM weekly_lineups WHERE member_id=${q(member)} AND game_date=${q(gameDay)} AND slot_type NOT IN ('BE','IR')`)
const teamsOf = (prefix: string) => json<Record<string, number>>(`SELECT coalesce(jsonb_object_agg(coalesce(nba_team,'none'),n),'{}') FROM (SELECT nba_team,count(*) n FROM players WHERE espn_id LIKE ${q(prefix + '%')} GROUP BY nba_team) t`)
const observations: Record<string, unknown>[] = []
try {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: a complete refresh may release any teamed player it does not list')
  year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
  assert.ok(year)
  await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${q(user)},${q(user + '@example.test')},jsonb_build_object('username',${q(user)}));
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id,nba_id,sleeper_id)
      VALUES(${q(xId)},'Synthetic',${q(x.last)},'PG',ARRAY['PG'],'Active','MIN',4,${q(x.espn)},${q(`t14-${run}-nba-x`)},${q(`t14-${run}-sleeper-x`)}),
            ${ys.map((guard, index) => `(${q(yIds[index])},'Synthetic',${q(guard.last)},'PG',ARRAY['PG'],'Active','BOS',4,${q(guard.espn)},NULL,NULL)`).join(',')};
    INSERT INTO leagues(id,slug,name,commissioner_id,status) VALUES(${q(league)},${q('t14-release-' + run)},'Synthetic release sweep',${q(user)},'active');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(user)},'commissioner','Release sweep');
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,${q(etDate(-3))},${q(etDate(3))});
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES(${q(game)},${q(`002t14${run}`)},${year},1,${q(gameDay)},${q(gameDay + 'T23:00:00Z')},'MIN','BOS','Scheduled');
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES(${q(prior)},${q(`002t14${run}prior`)},${year},1,${q(pastDay)},${q(pastDay + 'T23:00:00Z')},'MIN','BOS','Final');
    INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,minutes_played,points,did_not_play)
      VALUES(${q(xId)},${q(prior)},${year},1,${q(pastDay)},30,20,false);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      SELECT ${q(league)},${q(season)},${q(member)},id,'draft' FROM unnest(ARRAY[${[xId, ...yIds].map(q)}]::uuid[]) id;
    INSERT INTO lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES(${q(league)},${q(season)},${q(member)},true)
      ON CONFLICT (league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
    INSERT INTO weekly_lineups(member_id,league_id,league_season_id,player_id,week_number,game_date,slot_type,is_auto_set,set_at)
      VALUES(${q(member)},${q(league)},${q(season)},${q(xId)},1,${q(pastDay)},'PG',false,now());`)
  const sync = await serve(() => import('../../functions/sync-players/index.ts'))
  const optimizer = await serve(() => import('../../functions/lineup-optimizer/index.ts'))
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
  const refresh = async (label: string, next: Feed, status: number) => {
    feed = next
    const response = await invoke(sync)
    assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`)
    return response.body
  }
  const optimize = async (label: string) => {
    const response = await invoke(optimizer, { date: gameDay })
    assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.failed, 0, `${label}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.optimized, 1, `${label}: the owned member is optimized for ${gameDay}`)
    return await starters()
  }
  const startedOn = (rows: { player_id: string }[], id: string) => rows.some(row => row.player_id === id)
  const guardsStarted = (rows: { player_id: string }[]) => yIds.filter(id => startedOn(rows, id)).length

  // Refresh 1 (complete) lists X on MIN; the optimizer starts him on MIN's game day.
  const first = await refresh('refresh 1', { athletes: [...fillers, x, ...ys] }, 200)
  assert.equal(first.ok, true)
  const baseline = await identity(xId)
  assert.ok(baseline)
  assert.equal(baseline.nba_team, 'MIN')
  assert.equal(baseline.injury_status, 'DTD')
  assert.equal(baseline.status, 'Active')
  assert.equal(await sql(`SELECT count(*) FROM players WHERE espn_id LIKE ${q(`t14-${run}-%`)}`), String(fillers.length + 1 + ys.length))
  const firstStarters = await optimize('optimizer after refresh 1')
  assert.ok(startedOn(firstStarters, xId), `X starts on MIN's game day ${gameDay}: ${JSON.stringify(firstStarters)}`)
  assert.equal(guardsStarted(firstStarters), 4, 'X takes one of the five guard slots')
  const owned = await ownership(xId), lined = await lineups(xId)
  assert.equal(owned.length, 1)
  assert.equal(lined.length, 2, 'X keeps a past lineup row and the auto-set row for the game day')
  observations.push({ case: 'refresh-1-lists-x', x: baseline, starters: firstStarters })

  // MIN plays a final game now, after X's last listing; its box, stored through the real CDN import, omits him.
  const finalId = `002t14${run}f`, person = 7_000_000 + Math.floor(Math.random() * 1_000_000) * 10
  const boxed = [...fillers.filter(filler => filler.team === 'MIN'), ...fillers.filter(filler => filler.team === 'BOS'), ...ys]
  const lines = boxed.map((listed, index) => ({ personId: person + index, name: `Synthetic ${listed.last}`, played: '1', status: 'ACTIVE',
    statistics: { minutes: 'PT20M00.00S', points: 10, reboundsTotal: 0, reboundsOffensive: 0, reboundsDefensive: 0, assists: 0, steals: 0, blocks: 0, turnovers: 0,
      foulsPersonal: 0, fieldGoalsMade: 0, fieldGoalsAttempted: 0, threePointersMade: 0, threePointersAttempted: 0, freeThrowsMade: 0, freeThrowsAttempted: 0, plusMinusPoints: 0 } }))
  await sql(`UPDATE players SET career_games_checked_at=clock_timestamp()-interval '1 day' WHERE id=${q(xId)};
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
    VALUES(${q(final)},${q(finalId)},${year},1,${q(today)},clock_timestamp(),'MIN','BOS','Final',100,90,'Final')`)
  boxes.set(finalId, { gameId: finalId, gameStatus: 3, gameStatusText: 'Final', homeTeam: { teamTricode: 'MIN', score: 100, players: lines.slice(0, 17) },
    awayTeam: { teamTricode: 'BOS', score: 90, players: lines.slice(17) } })
  assert.equal(await syncStatsGame({ id: final, nba_game_id: finalId, season_year: year, week_number: 1, status: 'Final', home_score: 100, away_score: 90, game_status_text: 'Final' }), boxed.length)
  assert.equal(await sql(`SELECT count(*) FROM player_game_stats WHERE game_id=${q(final)} AND player_id=${q(xId)}`), '0', 'MIN\'s stored box omits X')
  assert.deepEqual(await identity(xId), baseline)

  // Incomplete or failed refreshes without X change nothing for him.
  const withoutX = [...fillers, ...ys]
  const unchanged = async (label: string) => {
    assert.deepEqual(await identity(xId), baseline, `${label}: X's row is unchanged`)
    assert.deepEqual(await ownership(xId), owned, `${label}: X's ownership is unchanged`)
    assert.deepEqual(await lineups(xId), lined, `${label}: X's lineups are unchanged`)
  }
  // A roster error fails the run before any import, so it reports no receipt at all.
  const incomplete: [string, Feed, number, string[] | undefined][] = [
    ['a team missing from the teams payload', { athletes: withoutX, teams: codes.filter(code => code !== 'UTAH') }, 200, ['missing roster UTA']],
    ['a roster error', { athletes: withoutX, failRoster: 'DEN' }, 500, undefined],
    ['a failed import chunk', { athletes: withoutX, blankName: true }, 500, ['1 import failure(s)']],
  ]
  for (const [label, next, status, skipped] of incomplete) {
    const body = await refresh(label, next, status)
    await unchanged(label)
    assert.equal(await sql(`SELECT count(*) FROM players WHERE espn_id LIKE ${q(`t14-${run}-%`)} AND nba_team IS NULL`), '0', `${label}: nobody is released`)
    observations.push({ case: `incomplete: ${label}`, status, released: body.released ?? null, releaseSkipped: body.releaseSkipped ?? null, failure: body.failure ?? body.error ?? null, x: await identity(xId) })
    assert.deepEqual(body.releaseSkipped, skipped, `${label}: the sweep is skipped and the run says why`)
    if (skipped) assert.deepEqual([body.released, body.releaseHeld], [0, { unproven: 0, unclaimed: 0 }], `${label}: a skipped sweep reports nobody`)
  }

  const injuries = () => json<{ id: string; injury_status: string | null }[]>(`SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'injury_status',injury_status) ORDER BY id),'[]')
    FROM players WHERE espn_id LIKE ${q(`t14-${run}-%`)}`)
  const storedInjuries = await injuries()
  assert.ok(storedInjuries.some(row => row.id !== xId && row.injury_status === 'Out'), 'An imported player has an injury to preserve')
  const injuryOutage = await refresh('an injuries error', { athletes: withoutX, failInjuries: true }, 200)
  assert.equal(injuryOutage.ok, true)
  assert.equal(injuryOutage.failure, null)
  assert.equal(injuryOutage.injuryWarnings, 1)
  assert.equal(injuryOutage.updated, withoutX.length)
  assert.equal(injuryOutage.inserted, 0)
  assert.deepEqual([injuryOutage.released, injuryOutage.releaseSkipped, injuryOutage.releaseHeld], [0, [], { unproven: 1, unclaimed: 0 }])
  assert.deepEqual(await injuries(), storedInjuries, 'An injury-feed outage preserves injuries on imported and omitted rows')
  await unchanged('an injuries error')
  observations.push({ case: 'injury-feed-outage', receipt: injuryOutage, injuriesPreserved: storedInjuries.length })

  assert.equal(await sql(`SELECT p.updated_at > g.game_time AND p.career_games_checked_at > g.game_time
    FROM players p, nba_games g WHERE p.id=${q(xId)} AND g.id=${q(final)}`), 't',
    'The refreshes since the box rewrote his row, so updated_at no longer dates his last listing')

  // Refresh 2 is complete and successful without X.
  const second = await refresh('refresh 2', { athletes: withoutX }, 200)
  assert.equal(second.ok, true)
  const after = await identity(xId), afterOwned = await ownership(xId), afterLined = await lineups(xId)
  assert.ok(after, 'X keeps his players row')
  const secondStarters = await optimize('optimizer after refresh 2')
  observations.push({ case: 'refresh-2-complete-without-x', released: second.released ?? null, releaseHeld: second.releaseHeld ?? null, x: after, roster: afterOwned, lineupsBeforeOptimizer: afterLined,
    starters: secondStarters, xAutoStarted: startedOn(secondStarters, xId), playingGuardsStarted: guardsStarted(secondStarters) })
  console.log(JSON.stringify(observations.at(-1)))
  assert.deepEqual(after, baseline, 'A complete refresh that omits X, after MIN\'s box omits him too, holds his row, ids, names, injury, status and team')
  assert.deepEqual(afterOwned, owned, 'He keeps his fantasy ownership')
  assert.deepEqual(afterLined, lined, 'He keeps his lineups')
  assert.equal(second.released, 0, 'Nobody is released')
  assert.deepEqual(second.releaseHeld, { unproven: 1, unclaimed: 0 }, 'X is reported as held, unproven')
  assert.deepEqual(await teamsOf(`t14-${run}-`), { ...Object.fromEntries(codes.map(code => [({ GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' } as Record<string, string>)[code] ?? code, 17])), BOS: 17 + ys.length, MIN: 18 })
  assert.ok(startedOn(secondStarters, xId), `A held player keeps starting on his team's game day: ${JSON.stringify(secondStarters)}`)
  assert.equal(guardsStarted(secondStarters), 4, 'X still takes one of the five guard slots')

  // A later listing on BOS is positive evidence of a move: it gives him his new team, on the same row.
  const third = await refresh('refresh 3', { athletes: [...fillers, { ...x, team: 'BOS' }, ...ys] }, 200)
  assert.equal(third.ok, true)
  assert.equal(third.released, 0)
  const reteamed = await identity(xId)
  assert.deepEqual(reteamed, { ...baseline, nba_team: 'BOS' }, 'The next listing re-teams the same row')
  assert.deepEqual(await ownership(xId), owned)
  const thirdStarters = await optimize('optimizer after refresh 3')
  assert.ok(startedOn(thirdStarters, xId), `The re-teamed player starts again: ${JSON.stringify(thirdStarters)}`)
  observations.push({ case: 'refresh-3-reteams-x', x: reteamed, starters: thirdStarters })
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe: 'players-t14-release-sweep', run, gameDay, today, observations }))
} finally {
  try {
    globalThis.fetch = nativeFetch
    for (const worker of workers) await worker.shutdown()
    await provider.shutdown()
  } finally {
    await sql(`DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM player_game_stats WHERE game_id IN (${q(final)},${q(prior)});
      DELETE FROM nba_games WHERE id IN (${q(game)},${q(final)},${q(prior)});
      ${year ? `DELETE FROM season_weeks WHERE season_year=${year};` : ''}
      DELETE FROM players WHERE id IN (${[xId, ...yIds].map(q)}) OR espn_id LIKE ${q(`t14-${run}-%`)};
      DELETE FROM profiles WHERE id=${q(user)};
      DELETE FROM auth.users WHERE id=${q(user)};
      DELETE FROM sync_runs WHERE function_name IN ('sync-players','lineup-optimizer') AND started_at >= ${q(started)};`)
  }
}
