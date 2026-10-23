import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { miniRoot, sha256, writeJson } from './common.mjs'
import { localKeys, sql } from './local-stack.mjs'
import { recoveryEvidence, recoveryHistoryQuery } from './recovery.mjs'
import { replay } from './replay.mjs'
import { twoPlan } from './two-checks.mjs'
import { sourceEvidence } from './source-manifest.mjs'
import { startRuntime } from './runtime.mjs'
import { dispatch } from './dispatch.mjs'

const { values } = parseArgs({ options: { snapshot: { type: 'string' }, receipt: { type: 'string' }, days: { type: 'string' }, 'refresh-players': { type: 'boolean' } } })
assert.ok(path.resolve(values.snapshot).startsWith(`${miniRoot}/`), 'Recovery uses a private snapshot copy')
assert.ok(path.resolve(values.receipt).startsWith(`${miniRoot}/`), 'Recovery uses a private receipt copy')
if (values.days) assert.match(values.days, /^[1-9]\d*$/)
const snapshot = JSON.parse(await readFile(path.join(values.snapshot, 'snapshot.json'), 'utf8'))
assert.equal(sha256(await readFile(path.join(values.snapshot, 'database.dump'))), snapshot.dumpSha256)
const receipt = JSON.parse(await readFile(values.receipt, 'utf8'))
const plan = await twoPlan()
const evidence = recoveryEvidence(snapshot, receipt, plan.seasons[0])
assert.equal((await sourceEvidence()).committedHarness, true, 'Recovery requires committed harness source')
process.env.SUPABASE_DB_URL = localKeys().DB_URL
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
const result = await replay({ resume: snapshot.cursor, recoveryEvidence: evidence, segment: snapshot.name, days: values.days })
assert.equal(result.complete, true)
assert.equal(result.fullAcceptance, false, 'A recovered segment never claims a fresh full run')
assert.ok(!result.failure && !result.failures?.length)
await writeJson(path.join(miniRoot, 'evidence/recovery-result.json'), { passed: true, dates: result.days.map(day => day.date), recovery: result.recovery, failure: result.failure ?? null })
