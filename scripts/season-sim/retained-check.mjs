import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { miniRoot, writeJson } from './common.mjs'
import { actionClient } from './actions.mjs'
import { assertFinals, assertLeaguePoints } from './assertions.mjs'
import { assertDomain, assertLiveCoverage } from './invariants.mjs'
import { assertClientScores, assertClosedWeeks } from './live-checks.mjs'
import { localKeys } from './local-stack.mjs'
import { setClock } from './clock.mjs'
import { saveSnapshot, snapshotRoot } from './checkpoints.mjs'
import { fixtureStore } from './fixtures.mjs'
import { planDay } from './planner.mjs'
import { sourceEvidence } from './source-manifest.mjs'

const { values } = parseArgs({ options: { date: { type: 'string' }, 'save-pre-playoffs': { type: 'boolean' } } })
assert.match(values.date ?? '', /^\d{4}-\d{2}-\d{2}$/)
const date = values.date
const retained = JSON.parse(await readFile(path.join(miniRoot, 'evidence/replay-checkpoint.json'), 'utf8'))
const snapshot = JSON.parse(await readFile(path.join(snapshotRoot(), 'live-week/snapshot.json'), 'utf8'))
const keys = localKeys()
process.env.SUPABASE_DB_URL = keys.DB_URL
process.env.SUPABASE_URL = keys.API_URL
const c = { ...snapshot.cursor.context, ...actionClient(keys) }
assert.equal(c.leagueSeasonId, retained.leagueSeasonId, 'Retained check requires the same league season')
for (const user of c.users) user.expiresAt = 0
const clock = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
await setClock({ at: new Date(clock.simMs).toISOString(), rate: 0, install: true })
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
