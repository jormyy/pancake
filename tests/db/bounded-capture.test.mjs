import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import { summarizeCapture } from '../../scripts/db-health/bounded-capture.mjs'
import { statementCoverageFromLog } from '../../scripts/db-health/statement-coverage.mjs'

const before = { database: 'postgres', capturedAt: '2026-10-28T10:00:00Z', statementStatsResetAt: 'unchanged', statements: [] }
const after = { ...before, capturedAt: '2026-10-28T10:05:00Z', statements: [{ queryId: '1', topLevel: true, calls: 2, query: 'SELECT id FROM players' }] }
function record(time, buffers = 1) {
  return JSON.stringify({ dbname: 'postgres', timestamp: time, message: `plan:\n${JSON.stringify({ 'Query Identifier': '1', 'Query Text': 'SELECT id FROM players', Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'players', 'Shared Hit Blocks': buffers, 'Actual Total Time': 1 } })}` })
}
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-bounded-capture-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('summarized segments retain coverage and costs before deleting raw capture files', async () => fixture(async directory => {
  const output = path.join(directory, 'summary'), first = path.join(directory, 'first.gz'), second = path.join(directory, 'second.gz')
  await writeFile(first, gzipSync([record('2026-10-28T09:59:00Z', 99), record('2026-10-28T10:01:00Z', 2)].join('\n')))
  await writeFile(second, gzipSync(record('2026-10-28T10:02:00Z', 7)))
  const initial = await summarizeCapture(first, output, before, after)
  const result = await summarizeCapture(second, output, before, after)
  await assert.rejects(readFile(first), /ENOENT/)
  await assert.rejects(readFile(second), /ENOENT/)
  await assert.rejects(readFile(path.join(output, initial.retained)), /ENOENT/)
  assert.equal(result.summary.capturedPlans, 2)
  assert.equal(result.summary.queries[0].buffers, 9)
  assert.equal(result.processed.length, 2)
  const retained = path.join(output, result.retained)
  assert.equal((await statementCoverageFromLog(before, after, retained)).complete, true)
  assert.equal(gunzipSync(await readFile(retained)).toString().includes('09:59:00'), false)
}))

test('invalid or oversized segments remain available after a rejected summary', async () => fixture(async directory => {
  const input = path.join(directory, 'bad.gz'), output = path.join(directory, 'summary')
  await writeFile(input, gzipSync('not JSON'))
  await assert.rejects(summarizeCapture(input, output, before), SyntaxError)
  assert.ok((await readFile(input)).length > 0)
  await assert.rejects(summarizeCapture(input, output, before, after, { maximumBytes: 1 }), /file limit/)
  await assert.rejects(readFile(path.join(output, 'state.json')), /ENOENT/)
}))

test('a new time interval cannot reuse existing capture state', async () => fixture(async directory => {
  const input = path.join(directory, 'one.gz'), next = path.join(directory, 'two.gz'), output = path.join(directory, 'summary')
  await writeFile(input, gzipSync(record('2026-10-28T10:01:00Z')))
  await summarizeCapture(input, output, before)
  await writeFile(next, gzipSync(record('2026-10-28T10:03:00Z')))
  await assert.rejects(summarizeCapture(next, output, { ...before, capturedAt: '2026-10-28T10:02:00Z' }), /another time interval/)
  assert.ok((await readFile(next)).length > 0)
}))
