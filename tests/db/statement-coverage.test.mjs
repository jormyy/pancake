import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { statementCoverage, statementCoverageFromLog } from '../../scripts/db-health/statement-coverage.mjs'
import { jsonLoggedPlans } from '../../scripts/db-health/plan-summary.mjs'

const before = { statementStatsResetAt: 'same', statements: [] }
const row = (queryId, query, calls = 1) => ({ queryId, query, calls, topLevel: true, userId: '10' })

test('coverage reports the missing plan instead of accepting another query', () => {
  const result = statementCoverage(before, { ...before, statements: [row('1', 'SELECT 1'), row('2', 'SELECT 2')] }, [{ 'Query Identifier': '1' }])
  assert.equal(result.complete, false)
  assert.equal(result.captured, 1)
  assert.equal(result.missing, 1)
  assert.equal(result.rows[1].coverage, 'missing plan')
  assert.equal(result.reviewed, false)
})

test('utility statements stay visible without requiring a scan plan', () => {
  const result = statementCoverage(before, { ...before, statements: [row('1', 'SET ROLE authenticated'), row('2', 'DO $$ BEGIN NULL; END $$')] }, [])
  assert.equal(result.complete, true)
  assert.equal(result.utilities, 2)
})

test('unchanged entries do not enlarge the workload', () => {
  const baseline = { ...before, statements: [row('1', 'SELECT 1', 3)] }
  assert.equal(statementCoverage(baseline, baseline, []).statements, 0)
  assert.throws(() => statementCoverage(baseline, { ...before, statements: [row('1', 'SELECT 1', 2)] }, []), /decrease/)
  assert.throws(() => statementCoverage(baseline, { ...baseline, statementStatsResetAt: 'other' }, []), /reset/)
})

test('server query identifiers retain all 64 bits and match signed counters', () => {
  const source = JSON.stringify({ message: 'plan:\n{"Query Identifier":18446744073709551615,"Query Text":"SELECT 1","Plan":{"Node Type":"Result"}}' })
  const plans = [...jsonLoggedPlans(source)]
  assert.equal(plans[0]['Query Identifier'], '18446744073709551615')
  const result = statementCoverage(before, { ...before, statements: [row('-1', 'SELECT 1')] }, plans)
  assert.equal(result.captured, 1)
  assert.throws(() => statementCoverage(before, before, [{ 'Query Identifier': 18446744073709551615 }]), /rounded/)
})

test('deallocating a prepared statement has no executor plan', () => {
  const result = statementCoverage(before, { ...before, statements: [row('3', 'deallocate $1')] }, [])
  assert.equal(result.complete, true)
  assert.equal(result.utilities, 1)
  assert.equal(result.captured, 0)
  assert.equal(result.reviewed, false)
})


test('streamed coverage preserves exact identifiers and repeated plan counts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-stream-coverage-'))
  try {
    const file = path.join(directory, 'plans.jsonl.gz')
    const line = JSON.stringify({ message: 'plan:\n{"Query Identifier":18446744073709551615,"Plan":{"Node Type":"Result"}}' })
    await writeFile(file, gzipSync(`${line}\n${line}\n${JSON.stringify({ message: 'statement: COMMIT' })}\n`))
    const after = { ...before, statements: [row('-1', 'SELECT 1'), row('9', 'SELECT 2')] }
    const result = await statementCoverageFromLog(before, after, file)
    assert.equal(result.rows[0].capturedPlans, 2)
    assert.equal(result.captured, 1)
    assert.equal(result.missing, 1)
    assert.equal(result.complete, false)
    await writeFile(file, gzipSync(`${line}\n{broken`))
    await assert.rejects(statementCoverageFromLog(before, after, file), SyntaxError)
    await writeFile(file, 'not gzip')
    await assert.rejects(statementCoverageFromLog(before, after, file), /header check/)
    await writeFile(file, gzipSync(JSON.stringify({ message: 'plan:\n{' })))
    await assert.rejects(statementCoverageFromLog(before, after, file), /Incomplete database plan record/)
    await assert.rejects(statementCoverageFromLog(before, after, path.join(directory, 'missing')), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('streamed coverage only credits the snapshot database', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-coverage-database-'))
  try {
    const file = path.join(directory, 'plans.jsonl.gz')
    const record = dbname => JSON.stringify({ dbname, message: 'plan:\n{"Query Identifier":1,"Plan":{"Node Type":"Result"}}' })
    const baseline = { ...before, database: 'postgres' }
    const after = { ...baseline, statements: [row('1', 'SELECT 1')] }
    await writeFile(file, gzipSync(`${record('benchmark')}\n`))
    const foreign = await statementCoverageFromLog(baseline, after, file)
    assert.equal(foreign.complete, false)
    assert.equal(foreign.missing, 1)
    await writeFile(file, gzipSync(`${record('benchmark')}\n${record('postgres')}\n`))
    const matched = await statementCoverageFromLog(baseline, after, file)
    assert.equal(matched.complete, true)
    assert.equal(matched.rows[0].capturedPlans, 1)
    assert.equal(matched.ignoredDatabaseRecords, 1)
    await writeFile(file, gzipSync(`${record(undefined)}\n`))
    const unknown = await statementCoverageFromLog(baseline, after, file)
    assert.equal(unknown.complete, false)
    assert.equal(unknown.unattributedPlans, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('coverage rejects snapshots from different databases', () => {
  assert.throws(() => statementCoverage({ ...before, database: 'postgres' }, { ...before, database: 'benchmark' }, []), /database/)
})

test('coverage only credits plans inside the measured capture interval', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-coverage-time-'))
  try {
    const file = path.join(directory, 'plans.jsonl.gz')
    const baseline = { ...before, database: 'postgres', capturedAt: '2026-10-28T10:00:00Z' }
    const after = { ...baseline, capturedAt: '2026-10-28T11:00:00Z', statements: [row('1', 'SELECT 1')] }
    const record = timestamp => JSON.stringify({ dbname: 'postgres', timestamp, message: 'plan:\n{"Query Identifier":1,"Plan":{"Node Type":"Result"}}' })
    await writeFile(file, gzipSync([record('2026-10-28T09:00:00Z'), record('2026-10-28T12:00:00Z')].join('\n')))
    const outside = await statementCoverageFromLog(baseline, after, file)
    assert.equal(outside.complete, false)
    assert.equal(outside.ignoredTimeRecords, 2)
    assert.equal(outside.missing, 1)
    await writeFile(file, gzipSync(record('2026-10-28T10:30:00Z')))
    assert.equal((await statementCoverageFromLog(baseline, after, file)).complete, true)
    await writeFile(file, gzipSync(record(undefined)))
    const untimed = await statementCoverageFromLog(baseline, after, file)
    assert.equal(untimed.complete, false)
    assert.equal(untimed.untimedPlans, 1)
    await assert.rejects(statementCoverageFromLog(baseline, { ...after, capturedAt: 'invalid' }, file), /capture interval/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a session query identifier cannot stand in for the nested statement identifier', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-coverage-nested-'))
  try {
    const file = path.join(directory, 'plans.jsonl.gz')
    const baseline = { ...before, database: 'postgres' }
    const after = { ...baseline, statements: [row('1', 'SELECT outer()'), row('2', 'SELECT nested()')] }
    await writeFile(file, gzipSync(JSON.stringify({ dbname: 'postgres', query_id: 1,
      message: 'plan:\n{"Query Identifier":2,"Plan":{"Node Type":"Result"}}' })))
    const result = await statementCoverageFromLog(baseline, after, file)
    assert.equal(result.rows[0].coverage, 'missing plan')
    assert.equal(result.rows[1].coverage, 'plan captured')
    assert.equal(result.complete, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
