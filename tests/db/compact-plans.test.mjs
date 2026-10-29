import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import { compactPlanLog } from '../../scripts/db-health/compact-plans.mjs'
import { jsonLoggedPlans } from '../../scripts/db-health/plan-summary.mjs'

function record(identifier, buffers, type = 'Seq Scan', milliseconds = 1) {
  const plan = { 'Query Text': 'SELECT id FROM public.players', Plan: { 'Node Type': type, 'Relation Name': 'players', 'Shared Hit Blocks': buffers, 'Actual Total Time': milliseconds } }
  const text = JSON.stringify(plan).replace('"Query Text":', `${identifier == null ? '' : `"Query Identifier":${identifier},`}"Query Text":`)
  return JSON.stringify({ message: `duration: ${milliseconds} ms plan:\n${text}` })
}

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-plan-compaction-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('plan compaction keeps exact identifiers and the highest buffer and time costs for each shape', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl.gz'), output = path.join(directory, 'review.jsonl.gz')
  const lines = [record('9223372036854775806', 9, 'Seq Scan', 20), record('9223372036854775806', 12), record('9223372036854775806', 12, 'Seq Scan', 3), record('-9007199254740993', 1), JSON.stringify({ message: 'statement: COMMIT' })]
  await writeFile(input, gzipSync(lines.join('\n')))
  const result = await compactPlanLog(input, output)
  assert.deepEqual({ records: result.records, plans: result.plans, ids: result.queryIdentifiers, kept: result.retainedPlans, identified: result.identified }, { records: 5, plans: 4, ids: 2, kept: 3, identified: true })
  const plans = [...jsonLoggedPlans(gunzipSync(await readFile(output)).toString())]
  assert.equal(plans[0]['Query Identifier'], '9223372036854775806')
  assert.equal(plans[0].Plan['Shared Hit Blocks'], 12)
  assert.equal(plans[0].Plan['Actual Total Time'], 3)
  assert.equal(plans[1].Plan['Actual Total Time'], 20)
  assert.equal(plans[2]['Query Identifier'], '-9007199254740993')
  assert.equal(gunzipSync(await readFile(input)).toString(), lines.join('\n'))
}))

test('different plans for one statement remain visible', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl'), output = path.join(directory, 'review.jsonl')
  await writeFile(input, [record('7', 10), record('7', 3, 'Index Scan')].join('\n'))
  const result = await compactPlanLog(input, output)
  assert.equal(result.queryIdentifiers, 1)
  assert.equal(result.retainedPlans, 2)
  assert.equal([...jsonLoggedPlans(await readFile(output, 'utf8'))].length, 2)
}))

test('the same query identifier in different databases keeps both plans', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl'), output = path.join(directory, 'review.jsonl')
  const entry = (dbname, buffers) => JSON.stringify({ ...JSON.parse(record('7', buffers)), dbname })
  await writeFile(input, [entry('postgres', 3), entry('benchmark', 10)].join('\n'))
  const result = await compactPlanLog(input, output)
  assert.equal(result.retainedPlans, 2)
  const databases = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line).dbname)
  assert.deepEqual(databases.sort(), ['benchmark', 'postgres'])
}))

test('missing plan identifiers cannot report complete capture', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl'), output = path.join(directory, 'review.jsonl')
  await writeFile(input, [record(null, 8), record('0', 2)].join('\n'))
  const result = await compactPlanLog(input, output)
  assert.equal(result.missingIdentifiers, 2)
  assert.equal(result.identified, false)
  assert.equal(result.retainedPlans, 2)
}))

test('raw evidence cannot be overwritten and malformed records fail', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl'), output = path.join(directory, 'review.jsonl')
  await writeFile(input, `${record('1', 1)}\n{broken`)
  await assert.rejects(compactPlanLog(input, input), /Keep the raw plan log/)
  await assert.rejects(compactPlanLog(input, output), SyntaxError)
  await assert.rejects(readFile(output), /ENOENT/)
}))


test('input and output errors reject instead of leaving a pending stream', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl.gz'), output = path.join(directory, 'absent', 'review.jsonl')
  await assert.rejects(compactPlanLog(input, output), /ENOENT/)
  await writeFile(input, 'not gzip')
  await assert.rejects(compactPlanLog(input, output), /header check/)
  await writeFile(input, gzipSync(record('1', 1)))
  await assert.rejects(compactPlanLog(input, output), /ENOENT/)
}))


test('different predicates are not collapsed into one reviewed plan', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl'), output = path.join(directory, 'review.jsonl')
  const first = JSON.parse(record('7', 10)), second = JSON.parse(record('7', 10))
  first.message = first.message.replace('"Node Type":', '"Filter":"league_id = a","Node Type":')
  second.message = second.message.replace('"Node Type":', '"Filter":"league_id = b","Node Type":')
  await writeFile(input, [first, second].map(row => JSON.stringify(row)).join('\n'))
  const result = await compactPlanLog(input, output)
  assert.equal(result.planShapes, 2)
  assert.equal(result.retainedPlans, 2)
}))

test('anonymous expression plans retain their output and function context', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl'), output = path.join(directory, 'review.jsonl')
  const anonymous = (context, expression) => JSON.stringify({ context, message: `plan:\n${JSON.stringify({ 'Query Text': '', Plan: { 'Node Type': 'Result', 'Plan Rows': 1, 'Plan Width': 4, Output: [expression] } })}` })
  await writeFile(input, [anonymous('SQL function a', '$1 + 1'), anonymous('SQL function a', '$1 + 2'), anonymous('SQL function b', '$1 + 1')].join('\n'))
  const result = await compactPlanLog(input, output)
  assert.equal(result.missingIdentifiers, 3)
  assert.equal(result.identified, false)
  assert.equal(result.retainedPlans, 3)
  assert.equal(result.planShapes, 3)
}))


test('rotated inputs merge without concatenating or changing the source files', async () => fixture(async directory => {
  const first = path.join(directory, 'one.jsonl.gz'), second = path.join(directory, 'two.jsonl.gz'), output = path.join(directory, 'review.jsonl.gz')
  await writeFile(first, gzipSync(record('1', 3)))
  await writeFile(second, gzipSync([record('1', 7), record('2', 4)].join('\n')))
  const result = await compactPlanLog([first, second], output)
  assert.equal(result.plans, 3)
  assert.equal(result.queryIdentifiers, 2)
  assert.equal(result.retainedPlans, 2)
  const plans = [...jsonLoggedPlans(gunzipSync(await readFile(output)).toString())]
  assert.equal(plans.find(row => row['Query Identifier'] === '1').Plan['Shared Hit Blocks'], 7)
  assert.equal([...jsonLoggedPlans(gunzipSync(await readFile(first)).toString())].length, 1)
  await assert.rejects(compactPlanLog([first, second], first), /Keep the raw plan log/)
}))

test('a capture limit stops oversized retained evidence without writing a partial result', async () => fixture(async directory => {
  const input = path.join(directory, 'raw.jsonl'), output = path.join(directory, 'review.jsonl')
  await writeFile(input, record('1', 2))
  await assert.rejects(compactPlanLog(input, output, { maximumBytes: 10 }), /capture limit/)
  await assert.rejects(readFile(output), /ENOENT/)
  await assert.rejects(compactPlanLog([], output), /At least one plan input/)
}))
