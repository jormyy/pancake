// Stack proof of the replay's January 1 NBA-move setup: on a fresh local stack of the product, the harness's own nbaTradeSetup
// on business date 2026-01-01 gives every raw-box NBA move of the pinned 2025-26 season (the plan's deadline trade and the
// draftee moves rookieMoves derives from the boxes) a fantasy owner through drop_player_atomic and add_free_agent_atomic, one
// subject per member, in the replay's season-2 league (actions.mjs integrated settings, real-season.mjs season-2 settings).
// Setup shortcuts, all SQL: the pinned calendar, the player rows, the season-2 rosters (two drafted rookies and one veteran
// per member, as activateRealRookies leaves them) and the active status stand in for season 1, the rookie draft and the
// activation route. Users, the league, joins, settings, drops and adds go through the local auth and REST APIs.
// usage, in a staged tree whose stack is fresh (just started, or `supabase-go db reset --local`):
//   eval "$(supabase-go status -o env)"
//   env -i PATH="$PATH" HOME="$HOME" API_URL="$API_URL" DB_URL="$DB_URL" ANON_KEY="$ANON_KEY" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
//     node scripts/season-sim/january-adds.mjs <api port> <db port> <pinned replay inputs> <result.json>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nextWaiverRun } from './waiver-scenarios.mjs'
import { fixtureStore } from './fixtures.mjs'
import { nbaTradeSetup, rookieListings, rookieMoves } from './two-actions.mjs'

const [apiPort, dbPort, inputs, output] = process.argv.slice(2)
assert.ok(/^\d{5}$/.test(apiPort ?? '') && /^\d{5}$/.test(dbPort ?? '') && inputs && output, 'usage: january-adds.mjs <api port> <db port> <inputs> <result.json>')
// The default local stack, the replays' and the live lane's blocks are never a target.
assert.ok(!/^(543|572|573|574|575|577|582)/.test(apiPort) && apiPort.slice(0, 3) === dbPort.slice(0, 3), 'Refusing a protected port block')
const api = process.env.API_URL, dbUrl = process.env.DB_URL, anon = process.env.ANON_KEY, service = process.env.SERVICE_ROLE_KEY
assert.equal(api, `http://127.0.0.1:${apiPort}`, 'API_URL is the named local stack')
const db = new URL(dbUrl ?? '')
assert.ok(db.hostname === '127.0.0.1' && db.port === dbPort && db.pathname === '/postgres', 'DB_URL is the named local stack')
assert.ok(anon && service, 'The stack status emits its local keys')

const date = '2026-01-01', at = Date.parse(`${date}T14:00:00Z`), began = Date.now(), run = randomBytes(6).toString('hex')
const q = value => `'${String(value).replaceAll("'", "''")}'`
const pg = { PATH: process.env.PATH, PGHOST: '127.0.0.1', PGPORT: dbPort, PGUSER: 'supabase_admin', PGDATABASE: 'postgres', PGPASSWORD: decodeURIComponent(db.password), PGPASSFILE: '/dev/null' }
const sql = statement => execFileSync('psql', ['-XqAt', '--set', 'ON_ERROR_STOP=1', '-f', '-'], { input: statement, env: pg, encoding: 'utf8' }).trim()
const json = statement => JSON.parse(sql(statement))
const calls = []
async function request(route, token, body) {
  const response = await fetch(`${api}${route}`, { method: body ? 'POST' : 'GET', headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' })
  const text = await response.text(), data = text ? JSON.parse(text) : null
  calls.push({ route: route.split('?')[0], status: response.status, ...(response.ok ? {} : { code: data?.code ?? null, message: data?.message ?? null }) })
  if (!response.ok) throw Object.assign(new Error(`${route}: HTTP ${response.status} ${JSON.stringify(data)}`), { status: response.status, data })
  return data
}
const rest = (user, query) => request(`/rest/v1/${query}`, user.token)
const rpc = (user, name, body) => request(`/rest/v1/rpc/${name}`, user.token, body)

assert.deepEqual(json("SELECT json_build_array((SELECT count(*) FROM leagues),(SELECT count(*) FROM players),(SELECT count(*) FROM auth.users),(SELECT count(*) FROM season_weeks))"), [0, 0, 0, 0], 'The stack is fresh')
// REAL-RAW inputs: the plan's calendar and draft board, and the draftee moves derived from every 2025-26 box as runRealSeason does.
const plan = JSON.parse(await readFile(path.join(inputs, 'two-season-plan.json'), 'utf8')), profile = plan.seasons[1]
// The harness clock (clock.sql, installed the way setClock does it) at rate 0: the league is set up at the moment runRealSeason
// applies the season-2 settings and activates it, before the 2026 schedule starts, then moves to the replay morning of the date.
const utc = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`, setupAt = `${profile.startYear}-08-16T14:00:00Z`
const clock = await readFile(new URL('./clock.sql', import.meta.url), 'utf8')
sql(clock.slice(clock.indexOf('BEGIN;')).replaceAll(":'sim_ms'", String(Date.parse(setupAt))).replaceAll(":'real_ms'", String(Date.now())).replaceAll(":'rate'", '0').replaceAll(":'cap_ms'", 'NULL'))
assert.equal(sql(`SELECT ${utc('now()')}`), setupAt, 'Business time is the season-2 setup moment')
const games = JSON.parse(await readFile(path.join(inputs, 'games.json'), 'utf8')).games.filter(row => row.id.startsWith(profile.prefix))
const store = await fixtureStore(inputs), listings = await rookieListings(plan.draft.rookies, games, id => store.json(`boxscore-${id}`))
const moves = rookieMoves(plan.draft.rookies, listings, profile.year), subjects = [...plan.nbaTrades, ...moves].filter(row => row.year === profile.year)
assert.deepEqual(subjects.map(row => [row.nbaId, row.from, row.to]), [['201935', 'LAC', 'CLE'], ['1642383', 'UTA', 'MEM'], ['1642910', 'UTA', 'BOS']])
for (const season of plan.seasons) sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES ${season.calendar.weeks.map(row => `(${season.year},${row.week_number},${q(row.week_start)},${q(row.week_end)})`).join(',')}`)

// Players: the subjects on their January 1 teams, the first eight real draftees (the snake auto-pick order) on the team of their
// last box listing before the date, and SYNTHETIC-chosen real veterans, one per member plus one free agent for the controls.
const teamOn = nbaId => listings.filter(row => row.nbaId === nbaId && row.date < date).at(-1)?.team
const person = (nbaId, name, team, pick = null) => { const [first, ...last] = name.split(' '); assert.ok(team, `${name} has a January 1 team`); return { id: randomUUID(), nbaId, first, last: last.join(' '), team, pick } }
const names = { 201935: 'James Harden' }, real = nbaId => plan.draft.rookies.find(row => row.nbaId === nbaId)
const subjectPeople = subjects.map(row => person(row.nbaId, real(row.nbaId)?.name ?? names[row.nbaId], row.from))
const rookies = [...plan.draft.rookies].sort((a, b) => a.pick - b.pick).slice(0, 8).map(row => person(row.nbaId, row.name, teamOn(row.nbaId), row.pick))
const veterans = [['2544', 'LeBron James', 'LAL'], ['201142', 'Kevin Durant', 'HOU'], ['201143', 'Al Horford', 'GSW'], ['201144', 'Mike Conley', 'MIN'], ['203999', 'Nikola Jokic', 'DEN']].map(([nbaId, name, team]) => person(nbaId, name, team))
const people = [...subjectPeople, ...rookies, ...veterans]
sql(`INSERT INTO players(id,first_name,last_name,nba_id,nba_team,position,eligible_positions,nba_draft_number) VALUES ${people.map(row => `(${q(row.id)},${q(row.first)},${q(row.last)},${q(row.nbaId)},${q(row.team)},'G',ARRAY['G'],${row.pick ?? 'NULL'})`).join(',')}`)

const users = []
for (let index = 0; index < 4; index++) {
  const email = `january-adds-${run}-${index}@example.test`, password = randomBytes(24).toString('hex')
  const created = await fetch(`${api}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }), redirect: 'error' })
  assert.ok(created.ok, `Local auth create: ${created.status}`)
  const login = await fetch(`${api}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'error' })
  assert.ok(login.ok, `Local auth login: ${login.status}`)
  const session = await login.json()
  users.push({ id: session.user.id, token: session.access_token, memberId: null })
}
const league = await rpc(users[0], 'create_league', { p_name: `January adds ${run}`, p_team_name: 'Synthetic home', p_auction_budget: 20 })
for (const [index, user] of users.slice(1).entries()) await rpc(user, 'join_league_by_invite_code', { p_invite_code: league.invite_code, p_team_name: `Synthetic away ${index + 1}` })
const leagueId = league.id
// createLeagueActions' integrated settings, except that the playoffs start in season 2's week (the 24-week 2026 calendar cannot
// hold season 1's week-23 start with rounds of 1 and 2 weeks); then runRealSeason's season-2 call as it is.
await rpc(users[0], 'update_league_configuration_atomic', { p_league_id: leagueId, p_settings: { waiver_mode: 'faab', faab_starting_budget: 100, weekly_add_limit: 1, roster_size: 3, ir_slots: 2, taxi_slots: 4, playoff_entrants: 4, playoff_start_week: profile.playoffStart, playoff_round_lengths: [1, 2] }, p_slots: [...['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'].map(slot_type => ({ slot_type, slot_count: 0 })), { slot_type: 'UTIL', slot_count: 2 }, { slot_type: 'BE', slot_count: 1 }] })
await rpc(users[0], 'update_league_configuration_atomic', { p_league_id: leagueId, p_settings: { skipped_weeks: [1], playoff_start_week: profile.playoffStart } })
const leagueSeasonId = sql(`SELECT id FROM league_seasons WHERE league_id=${q(leagueId)} AND is_current AND season_year=${profile.year}`)
assert.ok(leagueSeasonId, 'create_league opened the 2026 season')
const members = json(`SELECT json_object_agg(user_id,id) FROM league_members WHERE league_id=${q(leagueId)}`)
for (const user of users) user.memberId = members[user.id]
// Snake order: member n drafts picks n and 9-n.
const draftedRookies = rookies.map((row, index) => ({ playerId: row.id, pick: row.pick, owner: users[index < 4 ? index : 7 - index].memberId, nbaId: row.nbaId, name: `${row.first} ${row.last}` }))
const held = users.map((user, index) => [...draftedRookies.filter(row => row.owner === user.memberId).map(row => [row.playerId, 'draft']), [veterans[index].id, 'draft']].map(([player, via]) => ({ member: user.memberId, player, via })))
sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES ${held.flat().map(row => `(${q(leagueId)},${q(leagueSeasonId)},${q(row.member)},${q(row.player)},${q(row.via)})`).join(',')};
  UPDATE leagues SET status='active' WHERE id=${q(leagueId)};`)
// setClock's move: the replay morning of 2026-01-01, when runRealSeason calls nbaTradeSetup.
assert.equal(sql(`UPDATE season_sim.clock SET sim_ms=${at},real_ms=${Date.now()},rate=0,cap_ms=NULL WHERE singleton RETURNING singleton`), 't')
assert.equal(sql(`SELECT ${utc('now()')}`), `${date}T14:00:00Z`, 'Business time is the replay morning of 2026-01-01')

const state = () => json(`SELECT json_build_object('now',(SELECT ${utc('now()')}),
  'league',(SELECT row_to_json(l) FROM (SELECT status,waiver_mode,faab_starting_budget,weekly_add_limit,roster_size,ir_slots,taxi_slots,playoff_entrants,playoff_start_week,playoff_round_lengths FROM leagues WHERE id=${q(leagueId)}) l),
  'season',(SELECT row_to_json(s) FROM (SELECT season_year,is_current,skipped_weeks FROM league_seasons WHERE id=${q(leagueSeasonId)}) s),
  'slots',(SELECT json_object_agg(slot_type,slot_count) FROM lineup_slot_templates WHERE league_id=${q(leagueId)}),
  'roster',(SELECT coalesce(json_agg(r ORDER BY r.member_id,r.nba_id),'[]') FROM (SELECT r.member_id,p.nba_id,r.acquired_via,r.is_on_ir,r.is_on_taxi FROM roster_players r JOIN players p ON p.id=r.player_id WHERE r.league_season_id=${q(leagueSeasonId)}) r),
  'waivers',(SELECT coalesce(json_agg(w ORDER BY w.member_id),'[]') FROM (SELECT w.dropped_by_member_id AS member_id,p.nba_id,${utc('w.clears_at')} AS clears_at FROM waiver_wire_log w JOIN players p ON p.id=w.player_id WHERE w.league_season_id=${q(leagueSeasonId)}) w),
  'adds',(SELECT coalesce(json_agg(a ORDER BY a.member_id),'[]') FROM (SELECT member_id,week_number,add_count FROM weekly_add_counts WHERE league_season_id=${q(leagueSeasonId)}) a),
  'transactions',(SELECT coalesce(json_agg(t ORDER BY t.member_id,t.transaction_type),'[]') FROM (SELECT t.member_id,p.nba_id,t.transaction_type FROM roster_transactions t JOIN players p ON p.id=t.player_id WHERE t.league_season_id=${q(leagueSeasonId)}) t),
  'addWeek',(SELECT row_to_json(w) FROM (SELECT week_number,${utc('resets_at')} AS resets_at FROM private.current_add_week(${q(leagueId)},${q(leagueSeasonId)})) w))`)
const result = { provenance: 'REAL-RAW plan, calendar, draft board and boxes; SYNTHETIC users, veterans, rookie owners and SQL-seeded season-2 rosters', date, run, leagueId, leagueSeasonId, members: users.map(user => user.memberId), subjects: subjects.map(row => ({ nbaId: row.nbaId, from: row.from, to: row.to, firstAfter: row.firstAfter })), before: state() }
const save = () => writeFile(output, `${JSON.stringify({ ...result, calls, seconds: (Date.now() - began) / 1000 }, null, 1)}\n`)
const nba = Object.fromEntries(people.map(row => [row.id, row.nbaId])), active = (rows, member) => rows.filter(row => row.member_id === member && !row.is_on_ir && !row.is_on_taxi)
for (const user of users) assert.equal(active(result.before.roster, user.memberId).length, 3, 'Each season-2 roster is full: two drafted rookies and one veteran')
assert.deepEqual([result.before.adds, result.before.waivers], [[], []])

const c = { seasonYear: profile.year, leagueId, leagueSeasonId, users, draftedRookies, rest, rpc }
try { await nbaTradeSetup(c, date, plan, moves) } catch (error) {
  // A rejection is kept with its raw rows for classification before any fix.
  Object.assign(result, { rejection: { message: error.message, status: error.status ?? null, data: error.data ?? null }, after: state() })
  await save()
  throw error
}
result.after = state()
result.owners = c.nbaTradeSubjects.map(row => ({ nbaId: row.nbaId, owner: row.owner, playerId: row.playerId }))
await save()

const checks = result.checks = []
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name) }
const owners = c.nbaTradeSubjects.map(row => row.owner), vacated = owners.map(owner => nba[veterans[users.findIndex(user => user.memberId === owner)].id])
check('Business time', result.after.now, `${date}T14:00:00Z`)
check('Season-2 settings', [result.after.league, result.after.season], [{ status: 'active', waiver_mode: 'faab', faab_starting_budget: 100, weekly_add_limit: 1, roster_size: 3, ir_slots: 2, taxi_slots: 4, playoff_entrants: 4, playoff_start_week: profile.playoffStart, playoff_round_lengths: [1, 2] }, { season_year: profile.year, is_current: true, skipped_weeks: [1] }])
// The slot rule createLeagueActions asserts: UTIL 2, BE 1, IR 2 and every other slot 0.
check('Season-2 lineup slots', Object.entries(result.after.slots).filter(([slot, count]) => count !== ({ UTIL: 2, BE: 1, IR: 2 }[slot] ?? 0)).concat([result.after.slots.UTIL, result.after.slots.BE].includes(undefined) ? [['missing', null]] : []), [])
check('One subject per member, three members', new Set(owners).size, 3)
check('Every subject has its owner', c.nbaTradeSubjects.map(row => [row.nbaId, nba[row.playerId]]), subjects.map(row => [row.nbaId, row.nbaId]))
for (const [index, subject] of c.nbaTradeSubjects.entries()) check(`${subject.nbaId} is a free-agent add on its owner's roster`, result.after.roster.filter(row => row.nba_id === subject.nbaId).map(row => [row.member_id, row.acquired_via, row.is_on_ir, row.is_on_taxi]), [[owners[index], 'free_agent', false, false]])
for (const user of users) check(`Member ${user.memberId} active roster stays full`, active(result.after.roster, user.memberId).length, 3)
check('Every drafted rookie stays with its owner', draftedRookies.map(row => result.after.roster.filter(roster => roster.nba_id === row.nbaId).map(roster => roster.member_id)), draftedRookies.map(row => [row.owner]))
check('Only the three owners\' veterans were dropped, to waivers clearing on the first eligible 03:00 Eastern run', result.after.waivers.map(row => [row.member_id, row.nba_id, row.clears_at]).sort(), owners.map((owner, index) => [owner, vacated[index], new Date(nextWaiverRun(Date.parse(`${date}T14:00:00Z`) + 48 * 3600000)).toISOString().replace('.000Z', 'Z')]).sort())
check('Each owner used its one weekly add of week 11', [result.after.adds.map(row => [row.member_id, row.week_number, row.add_count]).sort(), result.after.addWeek], [owners.map(owner => [owner, 11, 1]).sort(), { week_number: 11, resets_at: '2026-01-05T05:00:00Z' }])
check('Transactions are one drop and one add per owner', result.after.transactions.map(row => [row.member_id, row.nba_id, row.transaction_type]).sort(), owners.flatMap((owner, index) => [[owner, subjects[index].nbaId, 'fa_add'], [owner, vacated[index], 'fa_drop']]).sort())
check('No drop or add was rejected', calls.filter(row => /drop_player_atomic|add_free_agent_atomic/.test(row.route)).map(row => [row.route.split('/').at(-1), row.status < 300]), owners.flatMap(() => [['drop_player_atomic', true], ['add_free_agent_atomic', true]]))

// Controls: the weekly limit and the roster cap are live, so the adds succeeded under them rather than around them.
const spare = veterans.at(-1).id, rejected = async (user, code) => {
  const error = await rpc(user, 'add_free_agent_atomic', { p_member_id: user.memberId, p_league_id: leagueId, p_player_id: spare }).then(() => null, error => error)
  return error?.data?.code === code
}
const keeper = users.find(user => !owners.includes(user.memberId))
check('A second add by an owner the same week is refused by the weekly limit', await rejected(users.find(user => user.memberId === owners[0]), 'PA001'), true)
check('An add by the fourth member to a full roster is refused by the roster cap', await rejected(keeper, 'PA003'), true)
check('The refused controls changed nothing', state().roster, result.after.roster)
result.passed = true
await save()
console.log(JSON.stringify({ passed: true, run, owners: result.owners.map(row => row.nbaId), checks: checks.length, seconds: (Date.now() - began) / 1000 }))
