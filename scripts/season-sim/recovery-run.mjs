import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { miniRoot, sha256, writeJson } from './common.mjs'
import { localKeys } from './local-stack.mjs'
import { recoveryEvidence } from './recovery.mjs'
import { replay } from './replay.mjs'
import { twoPlan } from './two-checks.mjs'
import { sourceEvidence } from './source-manifest.mjs'

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
const result = await replay({ resume: snapshot.cursor, recoveryEvidence: evidence, segment: snapshot.name, days: values.days, refreshPlayers: values['refresh-players'] })
assert.equal(result.complete, true)
assert.equal(result.fullAcceptance, false, 'A recovered segment never claims a fresh full run')
assert.ok(!result.failure && !result.failures?.length)
await writeJson(path.join(miniRoot, 'evidence/recovery-result.json'), { passed: true, dates: result.days.map(day => day.date), recovery: result.recovery, failure: result.failure ?? null })
