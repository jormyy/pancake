import { strict as assert } from 'node:assert'

// ESPN's team_since through a direct admin merge, and the one reader of it: the box-to-ESPN link (migration
// 320), which joins a box to an ESPN row only if ESPN has listed that row on the box's side since before the
// game tipped off, and only while the row carries no NBA id. One rolled-back transaction per case. ESPN has
// listed L ("Yongxi Cui<run>", no NBA id) on T since 72 hours ago, last 1 hour ago. S is a Sleeper-only row
// for the same man (no NBA id, no ESPN id). A box of a game T played 48 hours ago, imported now (a CDN
// backfill or the stat recovery), lists "Cui<run> Yongxi" under T: the same words in another order.
// - No merge: the box links to L.
// - merge_players(L, S) (the ESPN row survives): the box links to L.
// - merge_players(S, L) (the Sleeper row survives with L's ESPN id and listing): the listing keeps team_since,
//   so the box links to S. Without team_since the link reads listed_at (1 hour ago, after the tipoff), refuses
//   the box, and the box creates a second row for him.
// - Planted, as live-t19-box-sides plants it (no product path lists two rows of one person, since only the ESPN
//   import writes a listing, on the row it gives that ESPN id): S also carries an older listing, on A since 200
//   hours ago, last 100 hours ago. merge_players(S, L) keeps the later listing, L's, whole: on T since 72 hours.
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
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack')
const year = Number(await sql(`SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y)
  AND NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) LIMIT 1`))
assert.ok(year)

type Case = { name: string; merge: 'none' | 'espn survives' | 'sleeper survives'; planted?: boolean; expect: { rows: number; linkedTo: 'L' | 'S'; since: number | null } }
const cases: Case[] = [
  { name: 'no merge: the box links to the listed ESPN row', merge: 'none', expect: { rows: 2, linkedTo: 'L', since: 72 } },
  { name: 'the ESPN row survives the merge: the box links to it', merge: 'espn survives', expect: { rows: 1, linkedTo: 'L', since: 72 } },
  { name: 'the Sleeper row survives with the ESPN listing: the box links to it', merge: 'sleeper survives', expect: { rows: 1, linkedTo: 'S', since: 72 } },
  { name: 'both rows listed (planted): the later listing moves whole', merge: 'sleeper survives', planted: true, expect: { rows: 1, linkedTo: 'S', since: 72 } },
]
const results: Record<string, unknown>[] = []
for (const [index, testCase] of cases.entries()) {
  const espnRow = crypto.randomUUID(), sleeperRow = crypto.randomUUID(), game = `002t20s${run}${index}`
  const person = String(95_000_000 + Math.floor(Math.random() * 100_000) * 100 + index), last = `Cui${run}${index}`
  const merge = testCase.merge === 'espn survives' ? `SELECT merge_players(${q(espnRow)},${q(sleeperRow)});`
    : testCase.merge === 'sleeper survives' ? `SELECT merge_players(${q(sleeperRow)},${q(espnRow)});` : ''
  const survivor = testCase.merge === 'sleeper survives' ? sleeperRow : espnRow
  const result = await psql(`BEGIN;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id)
      VALUES(${q(espnRow)},'Yongxi',${q(last)},'SG',ARRAY['SG'],'Active','T',1,${q(`t20s-${run}-e${index}`)});
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,sleeper_id)
      VALUES(${q(sleeperRow)},'Yongxi',${q(last)},'SG',ARRAY['SG'],'Active','T',1,${q(`t20s-${run}-s${index}`)});
    INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at,team_since) VALUES(${q(espnRow)},'T',now()-interval '1 hour',now()-interval '72 hours');
    ${testCase.planted ? `INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at,team_since) VALUES(${q(sleeperRow)},'A',now()-interval '100 hours',now()-interval '200 hours');` : ''}
    INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES(${q(game)},${year},1,(now()-interval '48 hours')::date,now()-interval '48 hours','T','R','Final');
    ${merge}
    SELECT 'listing:'||coalesce((SELECT json_build_object('team',nba_team,'listed',round(extract(epoch FROM now()-listed_at)/3600),
      'since',round(extract(epoch FROM now()-team_since)/3600)) FROM private.player_espn_listings WHERE player_id=${q(survivor)}),'null'::json)::text;
    SELECT 'import:'||resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object('provider_id',${q(person)},
      'display_name',${q(`${last} Yongxi`)},'nba_game_id',${q(game)},'nba_team','T')))::text;
    SELECT 'after:'||json_build_object('rows',(SELECT count(*) FROM players WHERE last_name ILIKE ${q(last)} OR first_name ILIKE ${q(last)}),
      'owner',(SELECT CASE id WHEN ${q(espnRow)}::uuid THEN 'L' WHEN ${q(sleeperRow)}::uuid THEN 'S' ELSE 'a new row' END FROM players WHERE nba_id=${q(person)}),
      'side',(SELECT nba_team FROM private.player_game_memberships m JOIN players p ON p.id=m.player_id WHERE p.nba_id=${q(person)}))::text;
    ROLLBACK;`)
  assert.equal(result.code, 0, result.stderr)
  const lines = result.stdout.split('\n'), value = (tag: string) => JSON.parse(lines.find(row => row.startsWith(`${tag}:`))!.slice(tag.length + 1))
  const listing = value('listing') as { since: number | null } | null, after = value('after') as { rows: number; owner: string | null; side: string | null }
  results.push({ case: testCase.name, merge: testCase.merge, planted: testCase.planted ?? false, expect: testCase.expect, listing, import: value('import'), after,
    got: { rows: after.rows, linkedTo: after.owner, since: listing?.since ?? null } })
}

log({ provenance: 'SYNTHETIC', recipe: 'live-t20-merge-since', run, year, results,
  residue: JSON.parse(await sql(`SELECT json_build_object('players',(SELECT count(*) FROM players),'games',(SELECT count(*) FROM nba_games WHERE season_year=${year}),
    'listings',(SELECT count(*) FROM private.player_espn_listings))`)) })
assert.deepEqual(results.filter(row => JSON.stringify(row.got) !== JSON.stringify(row.expect)).map(row => row.case), [],
  'A merge keeps the ESPN listing whole, team_since included, so a box ESPN\'s listing corroborates still links to the survivor')
