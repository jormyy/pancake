import { strict as assert } from 'node:assert'

// Positive, dated departure evidence, case by case, through resolve_player_imports_atomic itself. Each case is
// one rolled-back transaction: ESPN omits P (a structurally complete 350-player listing), P is claimed, ESPN
// last listed him on his team 48 hours ago, and his team played a Final game 20 hours ago whose stored box
// omits him. The omission proves nothing (players-t17-real-played-last.ts, players-t17-silent-omission.ts). A
// stored box row or game membership in a game his team did not play does: he was on one of its two teams.
// It clears his team only when it is his latest stored listing in a regular-season, playoff, play-in or Cup
// final game and tipped off after ESPN last listed him on his team, and his team plays under that code in that
// season. A release clears the team and reports it as released, never one without the other; every other
// case keeps his team and reports him as held.
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

// A stored game that lists P, tipped off `hours` from now: a game his team did not play unless `own`. `lists`
// is how the store names him: 'played' and 'inactive' are what the CDN box import writes (a box row and the
// game membership), 'dnp' a DNP box row alone, 'member' a membership alone. `kind` is the NBA game id prefix.
type Listing = { hours: number; lists: 'played' | 'inactive' | 'dnp' | 'member'; own?: boolean; kind?: '001' | '002' | '003' | '004' | '005' | '006' }
// `team` is where his team plays that season: in the omitting Final game (default), only in another season, or
// nowhere (a code no game uses). `espn` is what player_espn_listings holds for him.
type Case = { name: string; listings: Listing[]; team?: 'other season' | 'nowhere'; espn?: 'other team' | 'none' | 'unclaimed'; listed?: boolean
  expect: 'released' | 'unproven' | 'unclaimed' | 'none' }
const away = (hours: number, lists: Listing['lists'] = 'played', kind?: Listing['kind']): Listing => ({ hours, lists, kind })
const home = (hours: number): Listing => ({ hours, lists: 'played', own: true })
const cases: Case[] = [
  { name: 'after his last ESPN listing, a box of a game his team did not play shows him playing', listings: [away(-10)], expect: 'released' },
  { name: 'the same box lists him inactive', listings: [away(-10, 'inactive')], expect: 'released' },
  { name: 'the same box has a DNP row alone', listings: [away(-10, 'dnp')], expect: 'released' },
  { name: 'that game records only his membership', listings: [away(-10, 'member')], expect: 'released' },
  { name: 'a playoff game his team did not play', listings: [away(-10, 'played', '004')], expect: 'released' },
  { name: 'a play-in game his team did not play', listings: [away(-10, 'played', '005')], expect: 'released' },
  { name: 'a Cup final his team did not play', listings: [away(-10, 'played', '006')], expect: 'released' },
  { name: 'his team\'s box listed him earlier, then the other team\'s game', listings: [home(-40), away(-10)], expect: 'released' },
  { name: 'the other team\'s game tipped off before ESPN last listed him', listings: [away(-68)], expect: 'unproven' },
  { name: 'a later box of his team lists him again', listings: [away(-30), home(-10)], expect: 'unproven' },
  { name: 'his team\'s game and the other game tip off together', listings: [home(-10), away(-10)], expect: 'unproven' },
  { name: 'the other game is an All-Star game', listings: [away(-10, 'played', '003')], expect: 'unproven' },
  { name: 'the other game is a preseason game', listings: [away(-10, 'played', '001')], expect: 'unproven' },
  { name: 'no game that season is played under his team code', listings: [away(-10)], team: 'nowhere', expect: 'unproven' },
  { name: 'his team code plays only in another season', listings: [away(-10)], team: 'other season', expect: 'unproven' },
  { name: 'ESPN last listed him on another team', listings: [away(-10)], espn: 'other team', expect: 'unproven' },
  { name: 'no ESPN listing time is on file for him', listings: [away(-10)], espn: 'none', expect: 'unproven' },
  { name: 'ESPN never claimed the row', listings: [away(-10)], espn: 'unclaimed', expect: 'unclaimed' },
  { name: 'the listing names him', listings: [away(-10)], listed: true, expect: 'none' },
]

const etDate = (hours: number) => new Date(Date.now() + hours * 3_600_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const run = crypto.randomUUID().slice(0, 8)
const listing = Array.from({ length: 350 }, (_, index) => ({ provider_id: `t17d-${run}-l${index}`, first_name: 'Listed', last_name: `T17d${run}L${index}` }))
const results: Record<string, unknown>[] = []
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: the release reads every teamed player')
assert.equal(await sql("SELECT to_regclass('private.player_espn_listings') IS NOT NULL"), 't', 'The ESPN listing table is required')
const year = Number(await sql(`SELECT y FROM generate_series(23000,29999) y
  WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year IN (y, y + 1)) LIMIT 1`))
assert.ok(year)
for (const [index, testCase] of cases.entries()) {
  const player = crypto.randomUUID(), team = `D${String(index).padStart(2, '0')}`, last = `T17d${run}P${index}`
  const espn = testCase.espn === 'unclaimed' ? null : `t17d-${run}-p${index}`
  const game = (gameIndex: number, kind: string, season: number, hours: number, home: string, away: string, lists?: Listing['lists']) => {
    const id = crypto.randomUUID()
    return `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
        VALUES(${q(id)},${q(`${kind}t17d${run}${index}g${gameIndex}`)},${season},1,${q(etDate(hours))},now()+interval '${hours} hours',${q(home)},${q(away)},'Final',now());
      ${lists === 'played' || lists === 'inactive' || lists === 'dnp' ? `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
        VALUES(${q(player)},${q(id)},${season},1,${q(etDate(hours))},${lists === 'played' ? 10 : 0},${lists !== 'played'});` : ''}
      ${lists === 'played' || lists === 'inactive' || lists === 'member' ? `INSERT INTO private.player_game_memberships(player_id,game_id) VALUES(${q(player)},${q(id)});` : ''}`
  }
  const statements = testCase.listings.map((stored, gameIndex) =>
    game(gameIndex, stored.kind ?? '002', year, stored.hours, ...(stored.own ? [team, `R${index}`] : [`O${index}`, `Q${index}`]) as [string, string], stored.lists))
  // His team's Final game 20 hours ago omits him (in another season, or under another code, where the case says).
  statements.push(game(testCase.listings.length, '002', testCase.team === 'other season' ? year + 1 : year, -20,
    testCase.team === 'nowhere' ? `N${index}` : team, `R${index}`))
  const names = testCase.listed ? [...listing.slice(1), { provider_id: espn!, first_name: 'Synthetic', last_name: last }] : listing
  const [receipt, kept] = (await sql(`BEGIN;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id)
      VALUES(${q(player)},'Synthetic',${q(last)},'PG',ARRAY['PG'],'Active',${q(team)},4,${espn ? q(espn) : 'NULL'});
    ${testCase.espn === 'none' || testCase.espn === 'unclaimed' ? '' : `INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at)
      VALUES(${q(player)},${q(testCase.espn === 'other team' ? `R${index}` : team)},now()-interval '48 hours');`}
    ${statements.join('\n')}
    SELECT resolve_player_imports_atomic('espn_release',${q(JSON.stringify(names))}::jsonb);
    SELECT coalesce(nba_team, 'none') FROM players WHERE id=${q(player)};
    ROLLBACK;`)).split('\n')
  const decision = JSON.parse(receipt) as { released: string[]; held: { unproven: string[]; unclaimed: string[] } }
  const named = [decision.released, decision.held.unproven, decision.held.unclaimed].filter(ids => ids.includes(player)).length
  // A release clears his team and says so; a cleared or changed team the receipt does not name, or a row named
  // twice, is a mismatch.
  const outcome = named > 1 ? 'mismatch' : decision.released.includes(player) ? (kept === 'none' ? 'released' : 'mismatch') : kept !== team ? 'mismatch'
    : decision.held.unproven.includes(player) ? 'unproven' : decision.held.unclaimed.includes(player) ? 'unclaimed' : 'none'
  const others = [...decision.released, ...decision.held.unproven, ...decision.held.unclaimed].filter(id => id !== player)
  results.push({ case: testCase.name, expect: testCase.expect, outcome, team: kept, others: others.length })
  assert.deepEqual(others, [], `${testCase.name}: the release reads only this case's rows`)
}
console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe: 'players-t17-departure-evidence', run, results }))
const wrong = results.filter(result => result.outcome !== result.expect)
assert.deepEqual(wrong, [], 'Every release decision matches its case')
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Every case rolled back')
