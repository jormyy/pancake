import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { miniRoot, writeJson } from './common.mjs'
import { actionClient } from './actions.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'
import { assertDomain, assertLiveCoverage } from './invariants.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { localKeys, sql } from './local-stack.mjs'
import { setClock } from './clock.mjs'
import { saveSnapshot, segmentNames, snapshotRoot } from './checkpoints.mjs'
import { fixtureStore } from './fixtures.mjs'
import { planDay } from './planner.mjs'
import { sourceEvidence } from './source-manifest.mjs'
import { retainedChampionCursor } from './retained-state.mjs'

const { values } = parseArgs({ options: { date: { type: 'string' }, 'save-pre-playoffs': { type: 'boolean' }, 'save-automatic-champion': { type: 'boolean' }, 'save-post-rollover': { type: 'boolean' }, 'context-snapshot': { type: 'string' } } })
if (!values['save-automatic-champion'] && !values['save-post-rollover']) assert.match(values.date ?? '', /^\d{4}-\d{2}-\d{2}$/)
assert.ok(!values['context-snapshot'] || segmentNames.includes(values['context-snapshot']), 'Context must name a known snapshot')
assert.ok([values['save-pre-playoffs'], values['save-automatic-champion'], values['save-post-rollover']].filter(Boolean).length <= 1, 'Choose one retained snapshot operation')
const date = values.date
const retained = JSON.parse(await readFile(path.join(miniRoot, 'evidence/replay-checkpoint.json'), 'utf8'))
const snapshot = JSON.parse(await readFile(path.join(snapshotRoot(), values['context-snapshot'] ?? 'live-week', 'snapshot.json'), 'utf8'))
const keys = localKeys()
process.env.SUPABASE_DB_URL = keys.DB_URL
process.env.SUPABASE_URL = keys.API_URL
const c = { ...snapshot.cursor.context, ...actionClient(keys) }
assert.equal(c.leagueSeasonId, retained.leagueSeasonId, 'Retained check requires the same league season')
for (const user of c.users) user.expiresAt = 0
const clock = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
await setClock({ at: new Date(clock.simMs).toISOString(), rate: 0, install: true })
if (values['save-automatic-champion'] || values['save-post-rollover']) {
  const stage = values['save-post-rollover'] ? 'post-rollover' : 'automatic-champion'
  const currentSeason = await sql(`SELECT id FROM league_seasons WHERE league_id='${c.leagueId}' AND is_current`)
  const final = JSON.parse(await sql(`SELECT row_to_json(m) FROM matchups m WHERE league_season_id='${retained.leagueSeasonId}' AND matchup_type='playoff_final'`))
  const cursor = retainedChampionCursor({ snapshot, retained, clock, currentSeason, final, stage })
  for (const user of cursor.context.users) {
    const headers = { apikey: keys.SERVICE_ROLE_KEY, Authorization: `Bearer ${keys.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }
    const lookup = await fetch(`${keys.API_URL}/auth/v1/admin/users/${user.id}`, { headers, redirect: 'error' })
    assert.ok(lookup.ok, 'Retained synthetic user exists in the local stack')
    const identity = await lookup.json()
    assert.match(identity.email, /^season-sim-[a-f0-9]+-\d+@example\.test$/, 'Only simulator users can receive replacement local sessions')
    const password = randomBytes(24).toString('hex')
    const reset = await fetch(`${keys.API_URL}/auth/v1/admin/users/${user.id}`, { method: 'PUT', headers, body: JSON.stringify({ password }), redirect: 'error' })
    assert.ok(reset.ok, 'Reset only the retained synthetic local user password')
    const login = await fetch(`${keys.API_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: keys.ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: identity.email, password }), redirect: 'error' })
    assert.ok(login.ok, 'Retained synthetic local user login succeeds')
    const session = await login.json()
    Object.assign(user, { token: session.access_token, refreshToken: session.refresh_token, expiresAt: Date.now() + session.expires_in * 1000 })
  }
  const saved = await saveSnapshot(stage, cursor)
  await writeJson(path.join(miniRoot, 'evidence/retained-champion-snapshot.json'), { ...saved, retainedFailure: retained.failure, completedDates: retained.days.length, at: new Date(clock.simMs).toISOString(), source: await sourceEvidence(), auth: 'New local sessions for existing synthetic users only; application business state is retained' })
  console.log(JSON.stringify(saved))
} else {
const games = JSON.parse(await readFile(path.join(miniRoot, 'fixtures/games.json'), 'utf8')).games.filter(game => game.date === date)
const store = await fixtureStore(path.join(miniRoot, 'fixtures'))
const plan = await planDay(games, store, date)
const origin = JSON.parse(await readFile(path.join(miniRoot, 'evidence/upstream-summary.json'), 'utf8'))
const verifiedWeeks = []
const proof = { date, source: await sourceEvidence(), mode: 'Retained-state harness recheck; no business maintenance or outcome writes', finals: await assertFinals(date), points: await assertLeaguePoints({ ...c, date }), client: await assertClientScores(c), weekly: await assertClosedWeeks(c, new Date(clock.simMs).toISOString().slice(0, 10), verifiedWeeks), domain: await assertDomain(c), coverage: assertLiveCoverage(origin, games, plan), passed: true }
await writeJson(path.join(miniRoot, 'evidence/r2-roster-maximum-green.json'), proof)
if (values['save-pre-playoffs']) {
  c.waiverScenarios = retained.waivers ?? []
  const latest = c.waiverScenarios.filter(row => row.checked).at(-1)
  if (latest) { c.expectedWaiverPriorities = latest.expected.priorities; c.expectedWaiverBudgets = latest.expected.budgets }
  const context = Object.fromEntries(Object.entries(c).filter(([, value]) => typeof value !== 'function'))
  await saveSnapshot('pre-playoffs', { date: new Date(clock.simMs).toISOString().slice(0, 10), clock: clock.simMs, verifiedWeeks, actions: retained.actions, context, options: { days: 4 }, evidence: { retainedCheck: 'r2-roster-maximum-green.json' } })
}
console.log(JSON.stringify({ passed: true, date, games: proof.finals.games, matchupSides: proof.client.checked, weekly: proof.weekly, maximums: proof.client.matchups.map(row => ({ id: row.id, home: row.home_max_possible_points, away: row.away_max_possible_points })) }))

}
