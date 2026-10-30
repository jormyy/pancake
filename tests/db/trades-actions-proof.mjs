import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { compareActionResults } from './trades-actions-report.mjs'

const rows = new Map()
for (const file of process.argv.slice(2)) {
  for (const result of JSON.parse(readFileSync(file, 'utf8'))) rows.set(`${result.name}/${result.manager}/${result.variant}`, result)
}
const proof = []
for (const [key, baseline] of rows) {
  if (baseline.variant !== 'baseline') continue
  const candidate = rows.get(key.replace(/baseline$/, 'candidate'))
  assert.ok(candidate, `Missing candidate for ${key}`)
  assert.ok(baseline.runtimeVerified && candidate.runtimeVerified, `Unverified runtime rows for ${key}`)
  compareActionResults(baseline, candidate)
  assert.equal(baseline.hash, candidate.hash)
  const changedResponse = { ...candidate, response: `${candidate.response} ` }
  assert.throws(() => compareActionResults(baseline, changedResponse), /response bytes/)
  const changedRows = { ...candidate, rows: { ...candidate.rows, 'negative.control': [{ changed: true }] } }
  assert.throws(() => compareActionResults(baseline, changedRows), /Touched table rows/)
  proof.push({ action: baseline.name, manager: baseline.manager, calls: baseline.metrics.calls, bytes: baseline.metrics.bytes,
    responseSha256: createHash('sha256').update(baseline.response).digest('hex'), stateSha256: baseline.hash,
    touchedTables: Object.keys(baseline.rows.after ?? baseline.rows).sort(), identical: true, negativeControls: 2 })
}
assert.equal(proof.length, 117)
process.stdout.write(`${JSON.stringify({ baseline: '952580ce', gateCommit: 'ab8f35fa', scenarios: 39, managers: 3, comparisons: proof.length, negativeControls: proof.length * 2, proof }, null, 2)}\n`)
