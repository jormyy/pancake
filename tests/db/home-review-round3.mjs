import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const target = databaseTarget()
const database = target.href
const member = '9fe20af7-b2fb-4ab6-bd42-2e2e7ccc5dd9'
const league = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
const run = (source, variables = []) => execFileSync('psql', [database, '-XqAt', '-v', 'ON_ERROR_STOP=1', ...variables, '-f', '-'], {
  input: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
}).trim()
const definitions = run("SELECT string_agg(pg_get_functiondef(oid), E';\n') FROM pg_proc WHERE oid IN ('public.view_home(uuid,uuid,jsonb)'::regprocedure,'public.view_context(uuid,uuid,jsonb)'::regprocedure,'public.view_lineup(uuid,uuid,jsonb)'::regprocedure)") + ';'
const frozen = definitions.replace(/\bnow\(\)/g, "(timestamptz '2026-10-28T04:21:00Z')")
const view = params => JSON.parse(run(`BEGIN;
${frozen}
SELECT set_config('request.jwt.claim.sub',(SELECT user_id::text FROM public.league_members WHERE id='${member}'),true) IS NOT NULL;
SELECT public.view_home('${league}','${member}','${JSON.stringify(params)}');
ROLLBACK;`).split('\n').at(-1))
const current = view({})
assert.equal(current.selectedDate, '2026-10-27', 'Home must still show Tuesday at 9:21 PM Pacific')
assert.equal(current.weekDays.find(day => day.isToday)?.date, '2026-10-27')
const tuesday = view({ date: '2026-10-27' })
const starters = tuesday.myLineup.starters.filter(slot => slot.player).map(slot => slot.player)
const bench = tuesday.myLineup.bench
const hasGame = player => Boolean(tuesday.teamMatchups[player.nbaTeam])
assert.equal(starters.length, 10, 'The supplied backup predates the reported empty slots')
assert.equal(starters.filter(hasGame).length, 4)
assert.equal(bench.filter(hasGame).length, 0, 'The supplied backup has no playing bench replacement')
const brown = [...starters, ...bench].find(player => player.displayName === 'Jaylen Brown')
assert.equal(brown?.nbaTeam, 'PHI')
assert.equal(tuesday.teamMatchups.PHI, undefined)
assert.deepEqual(tuesday.teamMatchups.BOS, { opponent: 'BKN', isHome: true })
const players = JSON.parse(run(`BEGIN READ ONLY;
SELECT set_config('request.jwt.claim.sub',(SELECT user_id::text FROM public.league_members WHERE id='${member}'),true) IS NOT NULL;
SELECT public.view_players('${league}','${member}','{"limit":20}');
ROLLBACK;`).split('\n').at(-1))
assert.equal(players.players.length, 20)
assert.equal(players.transactionState.weeklyAddLimit, 2)
assert.equal(typeof players.transactionState.faabBalance, 'number')
console.log(JSON.stringify({ selectedDate: current.selectedDate, today: current.weekDays.find(day => day.isToday)?.date, savedStarters: starters.length, playingStarters: starters.filter(hasGame).length, playingBench: bench.filter(hasGame).length, brownTeam: brown.nbaTeam, summaryInPlayersResponse: true }))
const roster = JSON.parse(run(`BEGIN READ ONLY;
SELECT set_config('request.jwt.claim.sub',(SELECT user_id::text FROM public.league_members WHERE id='${member}'),true) IS NOT NULL;
SELECT public.view_roster('${league}','${member}','{}');
ROLLBACK;`).split('\n').at(-1))
assert.ok(roster.roster.length > 0)
assert.ok(roster.roster.every(row => Object.hasOwn(row.players, 'birthdate')))
