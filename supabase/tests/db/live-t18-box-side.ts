import { strict as assert } from 'node:assert'

// The side a stored box lists a player under, from the CDN box import to the ESPN release sweep. The real
// Simmons transfer (live-t18-box-transfer-lineups.ts) shows the loss when a departure box clears his team to
// none: no game, no start. Here each condition of the fix is a case:
// - Release, one rolled-back transaction per case through resolve_player_imports_atomic: ESPN omits P (a
//   structurally complete 350-player listing), ESPN last listed him on his team 48 hours ago, and his team
//   played a Final game 20 hours ago that omits him. A stored game his team did not play, after that listing,
//   moves him to the side its box lists him under, and the receipt reports him as released and not as held.
//   A box row or membership without a side, or a side that is not a team of that game, clears his team, and
//   neither his side in an earlier box nor another player's side in that box counts. An All-Star, preseason
//   or earlier game, or a later game of his own team, moves nothing.
// - Import: the nba_cdn side needs its game and a team code, a later import without a side keeps it, a
//   corrected side replaces it, and the same side does not rewrite the membership.
// - Box: syncStatsGame records each side of a served synthetic box, writes nothing for a box it refuses, and
//   skips a side without a string team code while recording the other side.
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
assert.ok(api && db && key, 'Set the local stack URLs and its secret key')
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
async function psql(statement: string) {
  const child = new Deno.Command('psql', { args: [db!, '-XqAtv', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
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

const run = crypto.randomUUID().slice(0, 8)
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: the release reads every teamed player')
const year = Number(await sql(`SELECT y FROM generate_series(23000,29999) y
  WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) LIMIT 1`))
assert.ok(year)
const etDate = (hours: number) => new Date(Date.now() + hours * 3_600_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const listing = Array.from({ length: 350 }, (_, index) => ({ provider_id: `t18s-${run}-l${index}`, first_name: 'Listed', last_name: `T18s${run}L${index}` }))

// Release cases. Game 0 is a game his team did not play (home O, away Q) unless the case says otherwise;
// `writes` is how the store names him in it: through the nba_cdn import with or without a side, as a
// membership row written before this migration (no side), or as a box row alone; `other` is another
// player's membership in that game, with that side.
type Write = { game?: number; via: 'cdn' | 'member' | 'stats' | 'other'; side?: 'home' | 'away' | 'own' | 'XXX' | '  ' }
type Game = { hours: number; kind?: '001' | '002' | '003' | '004'; own?: boolean }
type Case = { name: string; games: Game[]; writes: Write[]; expect: 'home' | 'away' | 'none' | 'held' }
const away = (hours = -10, kind?: Game['kind']): Game => ({ hours, kind })
const cases: Case[] = [
  { name: 'the box lists him under the home side', games: [away()], writes: [{ via: 'cdn', side: 'home' }], expect: 'home' },
  { name: 'the box lists him under the away side', games: [away()], writes: [{ via: 'cdn', side: 'away' }], expect: 'away' },
  { name: 'a playoff box lists him under the home side', games: [away(-10, '004')], writes: [{ via: 'cdn', side: 'home' }], expect: 'home' },
  { name: 'the side is not a team of that game', games: [away()], writes: [{ via: 'cdn', side: 'XXX' }], expect: 'none' },
  { name: 'the membership has no side (nba_cdn without nba_team)', games: [away()], writes: [{ via: 'cdn' }], expect: 'none' },
  { name: 'a box row alone, no membership', games: [away()], writes: [{ via: 'stats' }], expect: 'none' },
  { name: 'a membership written without a side, then the box side', games: [away()], writes: [{ via: 'member' }, { via: 'cdn', side: 'away' }], expect: 'away' },
  { name: 'the box side, then the box import without a side', games: [away()], writes: [{ via: 'cdn', side: 'home' }, { via: 'cdn' }, { via: 'stats' }], expect: 'home' },
  { name: 'a corrected box names the other side', games: [away()], writes: [{ via: 'cdn', side: 'home' }, { via: 'cdn', side: 'away' }], expect: 'away' },
  { name: 'an earlier box lists his side, his latest box row has none', games: [away(-30), away(-10)], writes: [{ via: 'cdn', side: 'home' }, { game: 1, via: 'stats' }], expect: 'none' },
  { name: 'another player of his latest box has a side, his box row has none', games: [away()], writes: [{ via: 'other', side: 'home' }, { via: 'stats' }], expect: 'none' },
  { name: 'an All-Star box with a side', games: [away(-10, '003')], writes: [{ via: 'cdn', side: 'home' }], expect: 'held' },
  { name: 'a preseason box with a side', games: [away(-10, '001')], writes: [{ via: 'cdn', side: 'home' }], expect: 'held' },
  { name: 'the box tipped off before ESPN last listed him', games: [away(-68)], writes: [{ via: 'cdn', side: 'home' }], expect: 'held' },
  { name: 'a later box of his own team lists him', games: [away(-30), { hours: -5, own: true }], writes: [{ via: 'cdn', side: 'home' }, { game: 1, via: 'cdn', side: 'own' }], expect: 'held' },
]
const results: Record<string, unknown>[] = []
for (const [index, testCase] of cases.entries()) {
  const player = crypto.randomUUID(), team = `T${String(index).padStart(2, '0')}`, last = `T18s${run}P${index}`, person = `9${run.replace(/[^0-9]/g, '').padEnd(4, '0').slice(0, 4)}${String(index).padStart(3, '0')}`
  const ids = testCase.games.map((_, gameIndex) => `${testCase.games[gameIndex].kind ?? '002'}t18s${run}${index}g${gameIndex}`)
  const teams = testCase.games.map(game => game.own ? [team, `R${index}`] : [`O${index}`, `Q${index}`])
  const games = testCase.games.map((game, gameIndex) => `(${q(ids[gameIndex])},${year},1,${q(etDate(game.hours))},now()+interval '${game.hours} hours',${q(teams[gameIndex][0])},${q(teams[gameIndex][1])},'Final',now())`)
  // His team's Final game 20 hours ago omits him.
  games.push(`(${q(`002t18s${run}${index}own`)},${year},1,${q(etDate(-20))},now()-interval '20 hours',${q(team)},${q(`R${index}`)},'Final',now())`)
  const write = ({ game = 0, via, side }: Write) => {
    const gameId = ids[game]
    if (via === 'member') return `INSERT INTO private.player_game_memberships(player_id,game_id) SELECT ${q(player)},id FROM nba_games WHERE nba_game_id=${q(gameId)};`
    if (via === 'stats') return `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
      SELECT ${q(player)},id,${year},1,game_date,10,false FROM nba_games WHERE nba_game_id=${q(gameId)} ON CONFLICT DO NOTHING;`
    const code = side === 'home' ? teams[game][0] : side === 'away' ? teams[game][1] : side === 'own' ? team : side
    if (via === 'other') return `WITH other AS (INSERT INTO players(first_name,last_name,position,eligible_positions,status,years_exp)
        VALUES('Synthetic',${q(`${last}O`)},'PG',ARRAY['PG'],'Active',4) RETURNING id)
      INSERT INTO private.player_game_memberships(player_id,game_id,nba_team) SELECT other.id,g.id,${q(code!)} FROM other,nba_games g WHERE g.nba_game_id=${q(gameId)};`
    const record = { provider_id: person, display_name: `Synthetic ${last}`, nba_game_id: gameId, ...(code === undefined ? {} : { nba_team: code }) }
    return `SELECT resolve_player_imports_atomic('nba_cdn',${q(JSON.stringify([record]))}::jsonb) IS NOT NULL;`
  }
  const lines = (await sql(`BEGIN;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id,nba_id)
      VALUES(${q(player)},'Synthetic',${q(last)},'PG',ARRAY['PG'],'Active',${q(team)},4,${q(`t18s-${run}-p${index}`)},${q(person)});
    INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at) VALUES(${q(player)},${q(team)},now()-interval '48 hours');
    INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at) VALUES ${games.join(',')};
    ${testCase.writes.map(write).join('\n')}
    SELECT 'sides:'||coalesce(jsonb_agg(coalesce(m.nba_team,'-') ORDER BY g.game_time)::text,'[]') FROM private.player_game_memberships m JOIN nba_games g ON g.id=m.game_id WHERE m.player_id=${q(player)};
    SELECT 'receipt:'||resolve_player_imports_atomic('espn_release',${q(JSON.stringify(listing))}::jsonb)::text;
    SELECT 'team:'||coalesce(nba_team,'none') FROM players WHERE id=${q(player)};
    ROLLBACK;`)).split('\n')
  const value = (tag: string) => lines.find(line => line.startsWith(`${tag}:`))!.slice(tag.length + 1)
  const receipt = JSON.parse(value('receipt')) as { released: string[]; held: { unproven: string[]; unclaimed: string[] } }
  const kept = value('team'), expected = testCase.expect === 'home' ? teams[0][0] : testCase.expect === 'away' ? teams[0][1] : testCase.expect === 'none' ? 'none' : team
  const released = receipt.released.includes(player), held = receipt.held.unproven.includes(player) || receipt.held.unclaimed.includes(player)
  const outcome = released && held ? 'released and held' : released ? (kept === team ? 'released, team kept' : kept) : held ? (kept === team ? 'held' : 'held, team changed') : 'not a candidate'
  results.push({ case: testCase.name, expect: testCase.expect === 'held' ? 'held' : expected, outcome, sides: value('sides'), others: [...receipt.released, ...receipt.held.unproven, ...receipt.held.unclaimed].filter(id => id !== player).length })
}

// Import cases: what the nba_cdn side accepts, and what each later import does to a stored side.
const importer = crypto.randomUUID(), importPerson = `8${run.replace(/[^0-9]/g, '').padEnd(4, '0').slice(0, 4)}000`
const importGame = `002t18s${run}imp`
const setup = `INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,nba_id)
    VALUES(${q(importer)},'Synthetic',${q(`T18s${run}I`)},'PG',ARRAY['PG'],'Active','AAA',4,${q(importPerson)});
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES(${q(importGame)},${year},1,${q(etDate(-10))},now()-interval '10 hours','AAA','BBB','Final');`
const cdn = (fields: Record<string, unknown>) => `SELECT resolve_player_imports_atomic('nba_cdn',${q(JSON.stringify([{ provider_id: importPerson, display_name: `Synthetic T18s${run}I`, ...fields }]))}::jsonb) IS NOT NULL;`
const membership = `SELECT 'row:'||coalesce(m.nba_team,'-')||' '||m.ctid::text FROM private.player_game_memberships m JOIN nba_games g ON g.id=m.game_id WHERE m.player_id=${q(importer)} AND g.nba_game_id=${q(importGame)};`
const refusals: Record<string, unknown>[] = []
for (const [name, fields] of [
  ['a side without its game', { nba_team: 'AAA' }],
  ['a side that is not a string', { nba_game_id: importGame, nba_team: 7 }],
  ['a blank side', { nba_game_id: importGame, nba_team: '  ' }],
  ['an unsupported field beside the side', { nba_game_id: importGame, nba_team: 'AAA', team: 'AAA' }],
] as [string, Record<string, unknown>][]) {
  const result = await psql(`BEGIN; ${setup} ${cdn(fields)} ROLLBACK;`)
  refusals.push({ case: name, code: result.code, error: result.stderr.match(/ERROR:\s+(\w+): ([^\n]*)/)?.slice(1) ?? result.stderr.slice(0, 200) })
}
const sequence = (await sql(`BEGIN; ${setup}
  ${cdn({ nba_game_id: importGame, nba_team: 'BBB' })} ${membership}
  ${cdn({ nba_game_id: importGame, nba_team: 'BBB' })} ${membership}
  ${cdn({ nba_game_id: importGame })} ${membership}
  ${cdn({ nba_game_id: importGame, nba_team: 'AAA' })} ${membership}
  ROLLBACK;`)).split('\n').filter(line => line.startsWith('row:')).map(line => line.slice(4).split(' '))
const imports = { sides: sequence.map(([side]) => side), sameSideKeepsTheRow: sequence[0][1] === sequence[1][1], noSideKeepsTheRow: sequence[1][1] === sequence[2][1] }

// Box cases through the product's CDN box import against a local origin.
const statistics = Object.fromEntries(['assists', 'blocks', 'fieldGoalsAttempted', 'fieldGoalsMade', 'foulsPersonal', 'freeThrowsAttempted', 'freeThrowsMade', 'plusMinusPoints', 'points',
  'reboundsDefensive', 'reboundsOffensive', 'reboundsTotal', 'steals', 'threePointersAttempted', 'threePointersMade', 'turnovers'].map(stat => [stat, 1]))
const line = (personId: number) => ({ personId, name: `Synthetic T18s${run}B${personId}`, played: '1', statistics: { ...statistics, minutes: 'PT10M00.00S' } })
const base = 70_000_000 + Math.floor(Math.random() * 1_000_000) * 10, boxRun = 1000 + Math.floor(Math.random() * 8999)
// Each box is its own game (H0n at home, V0n away); the served box may name the sides differently.
const boxCases = [
  { name: 'each side of a final box', home: { teamTricode: 'H00', players: [line(base + 1)] }, away: { teamTricode: 'V00', players: [line(base + 2)] } },
  { name: 'a refused final box (an empty side)', home: { teamTricode: 'H01', players: [line(base + 3)] }, away: { teamTricode: 'V01', players: [] } },
  { name: 'sides without a team code', home: { teamTricode: '  ', players: [line(base + 4)] }, away: { players: [line(base + 5)] } },
  { name: 'a team code that is not a string', home: { teamTricode: 7, players: [line(base + 6)] }, away: { teamTricode: 'V03', players: [line(base + 7)] } },
]
const boxes = new Map<string, unknown>()
const provider = Deno.serve({ hostname: '127.0.0.1', port: originPort, onListen() {} }, request => {
  const found = new URL(request.url).pathname.match(/^\/cdn\/liveData\/boxscore\/boxscore_(\w+)\.json$/)
  return found && boxes.has(found[1]) ? Response.json({ game: boxes.get(found[1]) }) : new Response('the local origin has no such route', { status: 404 })
})
Deno.env.set('NBA_CDN_BASE_URL', `http://127.0.0.1:${originPort}/cdn`)
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input)
  assert.ok([new URL(api).origin, `http://127.0.0.1:${originPort}`].includes(target.origin), `Refused request to ${target.origin}`)
  return nativeFetch(input, init)
}
const boxResults: Record<string, unknown>[] = []
const gameIds: string[] = []
try {
  const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
  for (const [index, box] of boxCases.entries()) {
    const id = crypto.randomUUID(), gameId = `00298${boxRun}${index}`
    gameIds.push(gameId)
    boxes.set(gameId, { gameId, gameStatus: 3, gameStatusText: 'Final', homeTeam: { ...box.home, score: 100 }, awayTeam: { ...box.away, score: 90 } })
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,home_score,away_score,game_status_text)
      VALUES(${q(id)},${q(gameId)},${year},1,${q(etDate(-10))},now()-interval '10 hours',${q(`H0${index}`)},${q(`V0${index}`)},'Final',100,90,'Final')`)
    const outcome = await syncStatsGame({ id, nba_game_id: gameId, season_year: year, week_number: 1, status: 'Final', home_score: 100, away_score: 90, game_status_text: 'Final' })
      .then(lines => `stored ${lines}`, (error: Error) => `refused: ${error.message}`)
    const people = [...box.home.players, ...box.away.players].map(player => String(player.personId))
    const sides = await sql(`SELECT coalesce(jsonb_object_agg(p.nba_id, coalesce(m.nba_team,'-'))::text,'{}') FROM private.player_game_memberships m JOIN players p ON p.id=m.player_id WHERE m.game_id=${q(id)}`)
    const created = await sql(`SELECT count(*) FROM players WHERE nba_id IN (${people.map(q).join(',')})`)
    boxResults.push({ case: box.name, outcome: outcome.startsWith('stored') ? 'stored' : 'refused', detail: outcome, sides: JSON.parse(sides), playersWritten: Number(created) })
  }
} finally {
  globalThis.fetch = nativeFetch
  await provider.shutdown()
  // The stack started with no players, so every player row is this run's.
  await sql(`DELETE FROM player_game_stats WHERE game_id IN (SELECT id FROM nba_games WHERE season_year=${year});
    DELETE FROM nba_games WHERE season_year=${year};
    DELETE FROM private.score_input_revisions WHERE scope LIKE ${q(`nba:${year}:%`)} OR scope = ${q(`calendar:${year}`)} OR scope IN (SELECT 'player:'||id FROM players);
    DELETE FROM players;`)
}

console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe: 'live-t18-box-side', run, results, refusals, imports, boxResults,
  residue: JSON.parse(await sql(`SELECT json_build_object('players',(SELECT count(*) FROM players),'games',(SELECT count(*) FROM nba_games WHERE season_year=${year}),
    'memberships',(SELECT count(*) FROM private.player_game_memberships))`)) }))
assert.deepEqual(results.filter(result => result.outcome !== result.expect), [], 'Every release goes to the box side, to no team, or holds, as its case says')
assert.deepEqual(results.filter(result => result.others !== 0), [], 'The release reads only each case\'s rows')
assert.deepEqual(refusals.map(refusal => [refusal.case, refusal.code, (refusal.error as string[])[0]]), refusals.map(refusal => [refusal.case, 3, '22023']),
  'A malformed side is refused')
assert.deepEqual(imports, { sides: ['BBB', 'BBB', 'BBB', 'AAA'], sameSideKeepsTheRow: true, noSideKeepsTheRow: true },
  'A side is stored, kept by an import without one, replaced by a corrected one, and the same side does not rewrite the row')
assert.deepEqual(boxResults.map(result => [result.case, result.outcome, result.sides, result.playersWritten]), [
  [boxCases[0].name, 'stored', { [String(base + 1)]: 'H00', [String(base + 2)]: 'V00' }, 2],
  [boxCases[1].name, 'refused', {}, 0],
  [boxCases[2].name, 'stored', { [String(base + 4)]: '-', [String(base + 5)]: '-' }, 2],
  [boxCases[3].name, 'stored', { [String(base + 6)]: '-', [String(base + 7)]: 'V03' }, 2],
], 'The box import records each side, nothing for a refused box, and no side without a string team code')
