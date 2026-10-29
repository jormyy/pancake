import assert from 'node:assert/strict'
import test from 'node:test'
import { loggedPlans, summarizePlans, jsonLoggedPlans } from '../../scripts/db-health/plan-summary.mjs'

test('nested plan collection retains braces inside SQL strings and every plan', () => {
  const plan = { 'Query Text': 'SELECT \'{"key":"value"}\'', Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'sample',
    'Actual Rows': 20, 'Actual Loops': 2, 'Actual Total Time': 3, 'Shared Hit Blocks': 5 } }
  const input = `NOTICE: duration: 3 ms plan:\n${JSON.stringify(plan)}\nCONTEXT: ignored\nNOTICE: plan:\n${JSON.stringify(plan)}\n`
  const plans = loggedPlans(input)
  assert.equal(plans.length, 2)
  const summary = summarizePlans(plans)
  assert.equal(summary.distinctQueries, 1)
  assert.equal(summary.queries[0].milliseconds, 6)
  assert.equal(summary.queries[0].buffers, 10)
  assert.equal(summary.scans[0].maximumRows, 40)
  assert.equal(loggedPlans('NOTICE: no recorded plan').length, 0)
})

test('structured server records keep concurrent plans separate',()=>{
  const plan={'Query Text':'SELECT 1',Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1,'Actual Total Time':1}}
  const source=[{pid:1,message:`duration: 1 ms plan:\n\t${JSON.stringify(plan)}`},{pid:2,message:`duration: 1 ms plan:\n\t${JSON.stringify(plan)}`}].map(JSON.stringify).join('\n')
  const result=summarizePlans(jsonLoggedPlans(source))
  assert.equal(result.capturedPlans,2)
  assert.equal(result.distinctQueries,1)
  assert.throws(()=>loggedPlans('LOG: plan:\n\t{"Plan":'))
  assert.throws(()=>loggedPlans('LOG: plan:\n\t{broken}'))
})

test('PostgreSQL server log indentation does not hide captured plans',()=>{
  const plan={'Query Text':'SELECT 1',Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1,'Actual Total Time':1}}
  const input=`LOG: duration: 1 ms plan:\n\t${JSON.stringify(plan)}\n`
  assert.equal(loggedPlans(input).length,1)
})

test('scan review counts rows rejected by filters and index rechecks', () => {
  const summary = summarizePlans([{ 'Query Text': 'SELECT id FROM sample WHERE active', Plan: {
    'Node Type': 'Bitmap Heap Scan', 'Relation Name': 'sample', 'Actual Rows': 1, 'Actual Loops': 3,
    'Rows Removed by Filter': 1000, 'Rows Removed by Index Recheck': 20,
  } }])
  assert.equal(summary.scans[0].maximumRows, 3)
  assert.equal(summary.scans[0].maximumExaminedRows, 3063)
})

test('streamed summaries preserve database scope and distinguish anonymous contexts', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { gzipSync } = await import('node:zlib')
  const { summarizePlanLog } = await import('../../scripts/db-health/plan-summary.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'pancake-plan-summary-'))
  const file = join(directory, 'plans.gz')
  const record = (dbname, context) => JSON.stringify({ dbname, context, message: `plan:\n${JSON.stringify({ Plan: { 'Node Type': 'Result', 'Actual Total Time': 1 } })}` })
  try {
    await writeFile(file, gzipSync([record('postgres', 'first'), record('postgres', 'second'), record('foreign', 'third'), record(undefined, 'fourth')].join('\n')))
    const result = await summarizePlanLog(file, 'postgres')
    assert.equal(result.capturedPlans, 2)
    assert.equal(result.distinctQueries, 2)
    assert.equal(result.anonymousPlans, 2)
    assert.equal(result.ignoredRecords, 1)
    assert.equal(result.unattributedRecords, 1)
    assert.equal(result.reviewed, false)
    await assert.rejects(summarizePlanLog(file), /source database/)
    await writeFile(file, gzipSync('{broken'))
    await assert.rejects(summarizePlanLog(file, 'postgres'), SyntaxError)
    await assert.rejects(summarizePlanLog(join(directory, 'missing'), 'postgres'), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the summary retains slow and buffer-heavy plans and detects disk work', () => {
  const plan = (milliseconds, buffers, node = {}) => ({ 'Query Text': 'SELECT id FROM sample', Plan: {
    'Node Type': 'Index Scan', 'Index Name': 'sample_index', 'Actual Total Time': milliseconds, 'Shared Hit Blocks': buffers, ...node,
  } })
  const result = summarizePlans([plan(1, 20), plan(10, 2, { 'Temp Written Blocks': 1 }), plan(2, 30)])
  assert.equal(result.queries[0].sample.Plan['Shared Hit Blocks'], 30)
  assert.equal(result.queries[0].slowestSample.Plan['Actual Total Time'], 10)
  assert.equal(result.spilledPlans, 1)
  assert.deepEqual(result.indexes, [{ name: 'sample_index', calls: 3 }])
})
