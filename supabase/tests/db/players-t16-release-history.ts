import { strict as assert } from 'node:assert'

// Real NBA CDN boxes omit signed players: the players-t16 census of 2,460 pinned regular-season boxes found
// injured, two-way and assigned players listed inactive, then absent from their team's boxes for 1 to 46
// games, then listed again by the same team (players-t16-real-omission.ts serves two of those boxes). So
// the espn_release decision now also reads the latest stored box that lists P, through
// resolve_player_imports_atomic itself, one rolled-back transaction per case. In every case ESPN omits P
// (a structurally complete 350-player listing), P is claimed, ESPN last listed him on his team 48 hours
// ago, and his team's latest Final game tipped off 20 hours ago with its box stored and P absent from it:
// the turn-15 evidence. P is released only when the latest box that lists him shows him playing, or no
// box lists him at all. A DNP/inactive row or a bare game membership as his latest listing holds him.
//
// Lane-bound: the stack must be this checkout's own (supabase/config.toml project and ports, loopback),
// and the shared or protected blocks 543xx, 572xx, 574xx and 582xx are refused outright.
const config = await Deno.readTextFile(new URL('../../config.toml', import.meta.url))
const configured = (section: string) => config.match(new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
const project = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1]
const dbPort = configured('db')
assert.ok(project && dbPort, 'supabase/config.toml must declare project_id and the db port')
assert.equal(Deno.env.get('PANCAKE_TEST_PROJECT_ID'), project, 'PANCAKE_TEST_PROJECT_ID must name this checkout stack')
const db = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DB_URL')
assert.ok(db, 'Set the local stack database URL')
const target = new URL(db)
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Only a loopback stack is allowed')
assert.equal(target.port, dbPort, `Only this checkout's port ${dbPort} is allowed`)
assert.ok(!/^(543|572|574|582)\d\d$/.test(dbPort), `Refuse the shared or protected block of port ${dbPort}`)

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

// One earlier game: `days` from today, tip-off `hours` from now, on P's team unless `other`. `lists` is how the
// store names P for it: 'played' and 'inactive' are what the CDN box import writes (a box row and the game
// membership), 'dnp' is a DNP box row alone (as stored before memberships existed), 'member' a membership alone.
type Earlier = { days: number; hours: number; lists: 'played' | 'inactive' | 'dnp' | 'member'; other?: boolean }
type Case = { name: string; earlier: Earlier[]; expect: 'released' | 'unproven' }
const played = (days: number, hours: number, other?: boolean): Earlier => ({ days, hours, lists: 'played', other })
const inactive = (days: number, hours: number, other?: boolean): Earlier => ({ days, hours, lists: 'inactive', other })
const cases: Case[] = [
  { name: 'no stored box has ever listed him', earlier: [], expect: 'released' },
  { name: 'the last box that listed him shows him playing', earlier: [played(-3, -68)], expect: 'released' },
  { name: 'the last box that listed him lists him inactive (Lillard, Hyland)', earlier: [inactive(-3, -68)], expect: 'unproven' },
  { name: 'the last box that listed him has a DNP row alone', earlier: [{ days: -3, hours: -68, lists: 'dnp' }], expect: 'unproven' },
  { name: 'the last game that names him records only his membership', earlier: [{ days: -3, hours: -68, lists: 'member' }], expect: 'unproven' },
  { name: 'he played, then a later box lists him inactive', earlier: [played(-5, -116), inactive(-3, -68)], expect: 'unproven' },
  { name: 'he was inactive, then a later box shows him playing', earlier: [inactive(-5, -116), played(-3, -68)], expect: 'released' },
  { name: 'two listings on one date: the later tip-off is inactive', earlier: [played(-3, -70), inactive(-3, -66, true)], expect: 'unproven' },
  { name: 'two listings on one date: the later tip-off shows him playing', earlier: [inactive(-3, -70, true), played(-3, -66)], expect: 'released' },
  { name: 'his last listing is inactive on another team', earlier: [played(-7, -164), inactive(-3, -68, true)], expect: 'unproven' },
  { name: 'his last listing shows him playing on another team', earlier: [inactive(-7, -164), played(-3, -68, true)], expect: 'released' },
]

const etDate = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const run = crypto.randomUUID().slice(0, 8)
const listing = Array.from({ length: 350 }, (_, index) => ({ provider_id: `t16h-${run}-l${index}`, first_name: 'Listed', last_name: `T16h${run}L${index}` }))
const results: Record<string, unknown>[] = []
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: the release reads every teamed player')
assert.equal(await sql("SELECT to_regclass('private.player_espn_listings') IS NOT NULL"), 't', 'The ESPN listing table is required')
const year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
assert.ok(year)
for (const [index, testCase] of cases.entries()) {
  const player = crypto.randomUUID(), team = `H${String(index).padStart(2, '0')}`, espn = `t16h-${run}-p${index}`
  const game = (gameIndex: number, days: number, hours: number, home: string, away: string, lists?: Earlier['lists']) => {
    const id = crypto.randomUUID()
    return `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
        VALUES(${q(id)},${q(`002t16h${run}${index}g${gameIndex}`)},${year},1,${q(etDate(days))},now()+interval '${hours} hours',${q(home)},${q(away)},'Final',now());
      ${lists === 'played' || lists === 'inactive' || lists === 'dnp' ? `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
        VALUES(${q(player)},${q(id)},${year},1,${q(etDate(days))},${lists === 'played' ? 10 : 0},${lists !== 'played'});` : ''}
      ${lists === 'played' || lists === 'inactive' || lists === 'member' ? `INSERT INTO private.player_game_memberships(player_id,game_id) VALUES(${q(player)},${q(id)});` : ''}`
  }
  const statements = [
    ...testCase.earlier.map((earlier, gameIndex) => game(gameIndex, earlier.days, earlier.hours, ...(earlier.other ? [`O${index}`, `Q${index}`] : [team, `R${index}`]) as [string, string], earlier.lists)),
    game(testCase.earlier.length, -1, -20, team, `R${index}`),
  ]
  const receipt = await sql(`BEGIN;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id)
      VALUES(${q(player)},'Synthetic',${q(`T16h${run}P${index}`)},'PG',ARRAY['PG'],'Active',${q(team)},4,${q(espn)});
    INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at) VALUES(${q(player)},${q(team)},now()-interval '48 hours');
    ${statements.join('\n')}
    SELECT resolve_player_imports_atomic('espn_release',${q(JSON.stringify(listing))}::jsonb);
    ROLLBACK;`)
  const decision = JSON.parse(receipt) as { released: string[]; held: { unproven: string[]; unclaimed: string[] } }
  const outcome = decision.released.includes(player) ? 'released' : decision.held?.unproven?.includes(player) ? 'unproven'
    : decision.held?.unclaimed?.includes(player) ? 'unclaimed' : 'none'
  const others = [...decision.released, ...decision.held?.unproven ?? [], ...decision.held?.unclaimed ?? []].filter(id => id !== player)
  results.push({ case: testCase.name, expect: testCase.expect, outcome, others: others.length })
  assert.deepEqual(others, [], `${testCase.name}: the release reads only this case's rows`)
}
console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe: 'players-t16-release-history', run, results }))
const wrong = results.filter(result => result.outcome !== result.expect)
assert.deepEqual(wrong, [], 'Every release decision matches its case')
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Every case rolled back')
