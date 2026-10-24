import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { miniRoot, sha256, writeJson } from './common.mjs'
import { localKeys, sql } from './local-stack.mjs'
import { recoveryEvidence, recoveryHistoryQuery, postDraftStateQuery } from './recovery.mjs'
import { replay } from './replay.mjs'
import { twoPlan } from './two-checks.mjs'
import { sourceEvidence } from './source-manifest.mjs'
import { startRuntime } from './runtime.mjs'
import { dispatch } from './dispatch.mjs'

const { values } = parseArgs({ options: { snapshot: { type: 'string' }, receipt: { type: 'string' }, days: { type: 'string' }, through: { type: 'string' }, 'refresh-players': { type: 'boolean' } } })
assert.ok(path.resolve(values.snapshot).startsWith(`${miniRoot}/`), 'Recovery uses a private snapshot copy')
assert.ok(path.resolve(values.receipt).startsWith(`${miniRoot}/`), 'Recovery uses a private receipt copy')
if (values.days) assert.match(values.days, /^[1-9]\d*$/)
const snapshot = JSON.parse(await readFile(path.join(values.snapshot, 'snapshot.json'), 'utf8'))
assert.equal(sha256(await readFile(path.join(values.snapshot, 'database.dump'))), snapshot.dumpSha256)
assert.equal(sha256(await readFile(path.join(miniRoot, 'fixtures/manifest.jsonl'))), snapshot.fixtures.manifestSha256)
if (snapshot.fixtures.planSha256) assert.equal(sha256(await readFile(path.join(miniRoot, 'fixtures/two-season-plan.json'))), snapshot.fixtures.planSha256)
const receipt = JSON.parse(await readFile(values.receipt, 'utf8'))
const plan = await twoPlan()
const through=values.through??plan.seasons[1].calendar.weeks.find(row=>row.week_number===3).week_end
assert.match(through,/^\d{4}-\d{2}-\d{2}$/)
assert.ok(through>=plan.seasons[1].start&&through<=plan.seasons[1].end)
const evidence = recoveryEvidence(snapshot, receipt, plan.seasons[0])
assert.equal((await sourceEvidence()).committedHarness, true, 'Recovery requires committed harness source')
process.env.SUPABASE_DB_URL = localKeys().DB_URL
if (snapshot.cursor.stage === 'post-draft') {
  assert.ok(!values['refresh-players'], 'A completed draft recovery cannot repeat player setup')
  assert.equal(await sql(postDraftStateQuery()), snapshot.cursor.guard, 'Stored post-draft state must match the verified recovery snapshot')
}
if (values['refresh-players']) {
  assert.notEqual(process.env.SEASON_SIM_PRODUCTION_ONLY, '1', 'Recovery setup precedes the production replay')
  const before = await sql(recoveryHistoryQuery(snapshot.cursor.date))
  const runtime = await startRuntime(new Date(snapshot.cursor.clock).toISOString(), { resume: true })
  try {
    const outcomes = await dispatch("SELECT public.invoke_edge_function('sync-players')")
    const after = await sql(recoveryHistoryQuery(snapshot.cursor.date))
    assert.equal(after, before, 'Recovery player refresh preserves settled scoring history')
    evidence.recovery.playerRefresh = { at: new Date(snapshot.cursor.clock).toISOString(), before: JSON.parse(before), after: JSON.parse(after), outcomes, scope: 'Explicit product importer refresh before replay; dated fixture rosters; separate from scheduled cadence' }
    await writeJson(path.join(miniRoot, 'evidence/recovery-player-refresh.json'), evidence.recovery.playerRefresh)
  } finally { await runtime.close() }
}
const result = await replay({ resume: snapshot.cursor, recoveryEvidence: evidence, segment: snapshot.cursor.stage ?? snapshot.name, days: values.days, secondSeasonThrough: through })
assert.equal(result.complete, true)
assert.equal(result.fullAcceptance, false, 'A recovered segment never claims a fresh full run')
assert.ok(!result.failure && !result.failures?.length)
await writeJson(path.join(miniRoot, 'evidence/recovery-result.json'), { passed: true, dates: result.days.map(day => day.date), recovery: result.recovery, failure: result.failure ?? null })
