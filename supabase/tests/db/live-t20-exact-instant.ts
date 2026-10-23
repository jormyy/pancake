import { strict as assert } from 'node:assert'

// The release sweep at an exact instant (migration 340). A box counts as departure evidence when its game
// tipped off strictly after his latest placement on his current team: ESPN's listing there (listed_at) or a
// stored regular-season box under that team (its tipoff). At a tie nothing proves he left after he was placed,
// so he is held, as the rule holds him when an own-team listing or box is the later fact. One rolled-back
// transaction per case. P is on team T and omitted by a structurally complete 350-player listing; X is a whole
// minute ten hours ago (a schedule tipoff is a whole minute); T played a game 30 hours ago that does not list
// him, so T plays this season. Cases:
// - Listing arm: ESPN last listed him on T at exactly X, and his only other box, under V, is of a game (O at V)
//   that tipped off at X. Held. The same box a microsecond after the listing moves him to V; a microsecond
//   before it, he is held.
// - Box arm: his own box under T (T at R) tipped off at X and anchors him; his box under V (O at V) also tipped
//   off at X. Held. A microsecond later the V box moves him.
// - Same instant after the anchor: ESPN listed him on T 48 hours ago, and two games tipped off at X: one T
//   played (his stats row, no box side) and one under V. The game his team played wins the tie: held.
//
// Lane-bound: the stack must be this checkout's own (supabase/config.toml project and ports, loopback),
// and the shared or protected blocks 543xx, 572xx, 574xx, 577xx and 582xx are refused outright.
const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url))
const configured = (section: string) => config.match(new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
const project = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1]
const dbPort = configured('db')
assert.ok(project && dbPort, 'supabase/config.toml must declare project_id and the db port')
assert.equal(Deno.env.get('PANCAKE_TEST_PROJECT_ID'), project, 'PANCAKE_TEST_PROJECT_ID must name this checkout stack')
const refused = /^(543|572|574|577|582)\d\d$/
const db = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DB_URL')
assert.ok(db, 'Set the local stack database URL')
const target = new URL(db)
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only a loopback stack is allowed')
assert.equal(target.port, dbPort, `Only this checkout's port ${dbPort} is allowed`)
assert.ok(!refused.test(target.port), `Refuse the shared or protected block of port ${dbPort}`)

const q = (value: string) => `'${value.replaceAll("'", "''")}'`
async function psql(statement: string) {
  const child = new Deno.Command('psql', { args: [db!, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
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
const log = (row: Record<string, unknown>) => console.log(JSON.stringify(row))

const run = crypto.randomUUID().slice(0, 8)
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: the release reads every teamed player')
const year = Number(await sql(`SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y)
  AND NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) LIMIT 1`))
assert.ok(year)
const listing = Array.from({ length: 350 }, (_, index) => ({ provider_id: `t20x-${run}-l${index}`, first_name: 'Listed', last_name: `T20x${run}L${index}` }))
type Receipt = { released: string[]; held: { unproven: string[]; unclaimed: string[] } }

// Offsets are microseconds from X. A game lists him under a side, or (stats) only by a stats row.
type Game = { home: string; away: string; at: number; side?: string; stats?: boolean }
type Case = { name: string; arm: 'listing' | 'box' | 'after'; listing: number | 'before'; games: Game[]; expect: 'held' | 'V' }
const cases: Case[] = [
  { name: 'listing arm: the V box tipped off at the instant ESPN listed him on T', arm: 'listing', listing: 0,
    games: [{ home: 'O', away: 'V', at: 0, side: 'V' }], expect: 'held' },
  { name: 'listing arm: the V box tipped off a microsecond after the listing', arm: 'listing', listing: 0,
    games: [{ home: 'O', away: 'V', at: 1, side: 'V' }], expect: 'V' },
  { name: 'listing arm: the V box tipped off a microsecond before the listing', arm: 'listing', listing: 0,
    games: [{ home: 'O', away: 'V', at: -1, side: 'V' }], expect: 'held' },
  { name: 'box arm: his box under V tipped off at the instant of his own box under T', arm: 'box', listing: 'before',
    games: [{ home: 'T', away: 'R', at: 0, side: 'T' }, { home: 'O', away: 'V', at: 0, side: 'V' }], expect: 'held' },
  { name: 'box arm: his box under V tipped off a microsecond after his own box under T', arm: 'box', listing: 'before',
    games: [{ home: 'T', away: 'R', at: 0, side: 'T' }, { home: 'O', away: 'V', at: 1, side: 'V' }], expect: 'V' },
  { name: 'after the anchor: a game his team played and his box under V tipped off at the same instant', arm: 'after', listing: 'before',
    games: [{ home: 'T', away: 'R', at: 0, stats: true }, { home: 'O', away: 'V', at: 0, side: 'V' }], expect: 'held' },
]

const results: Record<string, unknown>[] = []
for (const [index, testCase] of cases.entries()) {
  const player = crypto.randomUUID(), person = 90_000_000 + Math.floor(Math.random() * 100_000) * 100 + index
  const games = testCase.games.map((game, number) => ({ ...game, id: crypto.randomUUID(), nba: `002t20x${run}${index}g${number}` }))
  const listedAt = testCase.listing === 'before' ? `x.at-interval '38 hours'` : `x.at+${testCase.listing}*interval '1 microsecond'`
  const result = await psql(`BEGIN;
    CREATE TEMP TABLE t20_x ON COMMIT DROP AS SELECT date_trunc('minute', now())-interval '10 hours' AS at;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id,nba_id)
      VALUES(${q(player)},'Synthetic',${q(`T20x${run}P${index}`)},'PG',ARRAY['PG'],'Active','T',4,${q(`t20x-${run}-p${index}`)},${q(String(person))});
    INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at) SELECT ${q(player)},'T',${listedAt} FROM t20_x x;
    INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
      SELECT ${q(`004t20x${run}${index}own`)},${year},1,(x.at-interval '30 hours')::date,x.at-interval '20 hours','T','Q','Final',now() FROM t20_x x;
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
      SELECT g.id::uuid,g.nba,${year},1,(x.at)::date,x.at+g.micros*interval '1 microsecond',g.home,g.away,'Final',now()
      FROM t20_x x, (VALUES ${games.map(game => `(${q(game.id)},${q(game.nba)},${game.at},${q(game.home)},${q(game.away)})`).join(',')}) AS g(id,nba,micros,home,away);
    ${games.filter(game => game.side).map(game => `INSERT INTO private.player_game_memberships(player_id,game_id,nba_team) VALUES(${q(player)},${q(game.id)},${q(game.side!)});`).join('\n')}
    ${games.filter(game => game.stats).map(game => `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
      SELECT ${q(player)},${q(game.id)},${year},1,x.at::date,10,false FROM t20_x x;`).join('\n')}
    SELECT 'instants:'||json_build_object('listed',(SELECT to_char(listed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') FROM private.player_espn_listings WHERE player_id=${q(player)}),
      'games',(SELECT jsonb_object_agg(nba_game_id,to_char(game_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')) FROM nba_games WHERE id::text IN (${games.map(game => q(game.id)).join(',')})))::text;
    SELECT 'receipt:'||resolve_player_imports_atomic('espn_release',${q(JSON.stringify(listing))}::jsonb)::text;
    SELECT 'team:'||coalesce(nba_team,'none') FROM players WHERE id=${q(player)};
    ROLLBACK;`)
  assert.equal(result.code, 0, result.stderr)
  const lines = result.stdout.split('\n'), value = (tag: string) => lines.find(row => row.startsWith(`${tag}:`))!.slice(tag.length + 1)
  const receipt = JSON.parse(value('receipt')) as Receipt, team = value('team')
  const released = receipt.released.includes(player), held = [...receipt.held.unproven, ...receipt.held.unclaimed].includes(player)
  results.push({ case: testCase.name, arm: testCase.arm, expect: testCase.expect, instants: JSON.parse(value('instants')),
    outcome: released && held ? 'released and held' : released ? team : held ? (team === 'T' ? 'held' : 'held, team changed') : 'not a candidate',
    others: [...receipt.released, ...receipt.held.unproven, ...receipt.held.unclaimed].filter(id => id !== player).length })
}

log({ provenance: 'SYNTHETIC', recipe: 'live-t20-exact-instant', run, year, results,
  residue: JSON.parse(await sql(`SELECT json_build_object('players',(SELECT count(*) FROM players),'games',(SELECT count(*) FROM nba_games WHERE season_year=${year}),
    'memberships',(SELECT count(*) FROM private.player_game_memberships),'listings',(SELECT count(*) FROM private.player_espn_listings))`)) })
assert.deepEqual(results.filter(row => row.others !== 0).map(row => row.case), [], 'Each release reads only its case\'s rows')
assert.deepEqual(results.filter(row => row.outcome !== row.expect).map(row => row.case), [],
  'A box is departure evidence only when it tipped off strictly after his latest placement on his team; at a tie he is held')
