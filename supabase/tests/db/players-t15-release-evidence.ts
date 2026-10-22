import { strict as assert } from 'node:assert'

// The espn_release decision, case by case, through resolve_player_imports_atomic itself. Each case is one
// transaction that is rolled back: a structurally complete 350-player listing that names nobody below (or
// names P where the case says so), one candidate row P on its own team, and that team's stored games.
// ESPN absence alone never clears a team: P is released only when he is claimed (espn_id) and his team's
// latest Final game has its complete box stored, tipped off after ESPN last listed him on that team, and
// neither it nor any later box lists him (played, DNP/inactive or as a game member). Everyone else ESPN
// omits is held. P's row is always written just now, as the career-games refresh writes every claimed row
// on every run, so the decision cannot lean on players.updated_at.
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

const run = crypto.randomUUID().slice(0, 8)
const listing = Array.from({ length: 350 }, (_, index) => ({ provider_id: `t15e-${run}-l${index}`, first_name: 'Listed', last_name: `T15e${run}L${index}` }))

// A game of P's team, `days` from today with its tip-off `hours` from now. `lists` is how the store names
// P for it: a played box row with its game membership (what the CDN box import writes), a DNP box row
// alone (an inactive listing, as stored before memberships existed), a membership alone, or not at all.
type Game = { days: number; hours: number; status?: 'Final' | 'InProgress'; synced?: boolean; away?: boolean; other?: boolean; lists?: 'played' | 'dnp' | 'member' }
// `listing` is what player_espn_listings holds for P: his team `listedHoursAgo` hours ago (default 48),
// another team, or nothing.
type Case = { name: string; games: Game[]; claimed?: boolean; listed?: boolean; namesake?: boolean; untamed?: boolean; listedHoursAgo?: number
  listing?: 'other' | 'none'; expect: 'released' | 'unproven' | 'unclaimed' | 'none' }
const latest: Game = { days: -1, hours: -20, synced: true }
const cases: Case[] = [
  { name: 'his team\'s latest stored box, played after ESPN last listed him, omits him', games: [latest], expect: 'released' },
  { name: 'the same evidence with his team away', games: [{ ...latest, away: true }], expect: 'released' },
  { name: 'an earlier box lists him and the latest omits him', games: [{ days: -3, hours: -68, synced: true, lists: 'played' }, latest], listedHoursAgo: 72, expect: 'released' },
  { name: 'ESPN never claimed the row (a stale listing on file changes nothing)', games: [latest], claimed: false, expect: 'unclaimed' },
  { name: 'the latest box lists him as played', games: [{ ...latest, lists: 'played' }], expect: 'unproven' },
  { name: 'the latest box lists him inactive (DNP row)', games: [{ ...latest, lists: 'dnp' }], expect: 'unproven' },
  { name: 'the latest game records him only as a member', games: [{ ...latest, lists: 'member' }], expect: 'unproven' },
  { name: 'the latest box tipped off before ESPN last listed him (a new signing)', games: [latest], listedHoursAgo: 2, expect: 'unproven' },
  { name: 'ESPN last listed him on another team', games: [latest], listing: 'other', expect: 'unproven' },
  { name: 'no ESPN listing time is on file for him (a merge winner)', games: [latest], listing: 'none', expect: 'unproven' },
  { name: 'the latest Final game has no stored box yet', games: [{ days: -2, hours: -44, synced: true }, { days: -1, hours: -20, synced: false }], listedHoursAgo: 72, expect: 'unproven' },
  { name: 'a later live box lists him, on another team', games: [latest, { days: 0, hours: -1, status: 'InProgress', other: true, lists: 'played' }], expect: 'unproven' },
  { name: 'his team has no Final game', games: [{ days: 1, hours: 28, status: 'InProgress' }], expect: 'unproven' },
  { name: 'the listing names him', games: [latest], listed: true, expect: 'none' },
  { name: 'a listed player of his name resolved to no row (ambiguous)', games: [latest], namesake: true, expect: 'none' },
  { name: 'he has no team', games: [latest], untamed: true, expect: 'none' },
]

const etDate = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const results: Record<string, unknown>[] = []
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated stack: the release reads every teamed player')
// A tree without the listing table (before this change) still runs every case, so it shows its decisions.
const listings = await sql("SELECT to_regclass('private.player_espn_listings') IS NOT NULL") === 't'
const year = Number(await sql('SELECT y FROM generate_series(23000,29999) y WHERE NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
assert.ok(year)
for (const [index, testCase] of cases.entries()) {
  const player = crypto.randomUUID(), team = `E${String(index).padStart(2, '0')}`, last = `T15e${run}P${index}`
  const espn = testCase.claimed === false ? null : `t15e-${run}-p${index}`
  const names = testCase.listed ? [...listing.slice(1), { provider_id: espn!, first_name: 'Synthetic', last_name: last }]
    : testCase.namesake ? [...listing.slice(1), { provider_id: `t15e-${run}-namesake${index}`, first_name: 'Synthetic', last_name: last }] : listing
  const statements = testCase.games.map((game, gameIndex) => {
    const id = crypto.randomUUID(), [home, away] = game.other ? [`O${index}`, `Q${index}`] : game.away ? [`R${index}`, team] : [team, `R${index}`]
    return `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
        VALUES(${q(id)},${q(`002t15e${run}${index}g${gameIndex}`)},${year},1,${q(etDate(game.days))},now()+interval '${game.hours} hours',${q(home)},${q(away)},
          ${q(game.status ?? 'Final')},${game.synced ? 'now()' : 'NULL'});
      ${game.lists === 'played' || game.lists === 'dnp' ? `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
        VALUES(${q(player)},${q(id)},${year},1,${q(etDate(game.days))},${game.lists === 'played' ? 10 : 0},${game.lists === 'dnp'});` : ''}
      ${game.lists === 'played' || game.lists === 'member' ? `INSERT INTO private.player_game_memberships(player_id,game_id) VALUES(${q(player)},${q(id)});` : ''}`
  })
  const receipt = await sql(`BEGIN;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,espn_id)
      VALUES(${q(player)},'Synthetic',${q(last)},'PG',ARRAY['PG'],'Active',${testCase.untamed ? 'NULL' : q(team)},4,${espn ? q(espn) : 'NULL'});
    ${testCase.listing === 'none' || !listings ? '' : `INSERT INTO private.player_espn_listings(player_id,nba_team,listed_at)
      VALUES(${q(player)},${q(testCase.listing === 'other' ? `R${index}` : team)},now()-interval '${testCase.listedHoursAgo ?? 48} hours');`}
    ${testCase.games.length ? statements.join('\n') : ''}
    SELECT resolve_player_imports_atomic('espn_release',${q(JSON.stringify(names))}::jsonb);
    ROLLBACK;`)
  const decision = JSON.parse(receipt) as { released: string[]; held: { unproven: string[]; unclaimed: string[] } }
  const outcome = decision.released.includes(player) ? 'released' : decision.held?.unproven?.includes(player) ? 'unproven'
    : decision.held?.unclaimed?.includes(player) ? 'unclaimed' : 'none'
  const others = [...decision.released, ...decision.held?.unproven ?? [], ...decision.held?.unclaimed ?? []].filter(id => id !== player)
  results.push({ case: testCase.name, expect: testCase.expect, outcome, others: others.length })
  assert.deepEqual(others, [], `${testCase.name}: the release reads only this case's rows`)
}
console.log(JSON.stringify({ provenance: 'SYNTHETIC', recipe: 'players-t15-release-evidence', run, listings, results }))
const wrong = results.filter(result => result.outcome !== result.expect)
assert.deepEqual(wrong, [], 'Every release decision matches its case')
assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Every case rolled back')
