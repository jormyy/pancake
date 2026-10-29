import assert from 'node:assert/strict'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createGunzip, createGzip } from 'node:zlib'
import { jsonLoggedPlans } from './plan-summary.mjs'

const shapeKeys = ['Node Type', 'Relation Name', 'Schema', 'Index Name', 'Join Type', 'Strategy', 'Operation', 'Parent Relationship', 'Parallel Aware', 'Scan Direction', 'Sort Key', 'Group Key', 'Plan Rows', 'Plan Width', 'Filter', 'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'One-Time Filter']

function shape(node, anonymous = false) {
  return { ...Object.fromEntries(shapeKeys.filter(key => key in node).map(key => [key, node[key]])),
    ...(anonymous ? { Output: node.Output } : {}),
    Plans: (node.Plans ?? []).map(child => shape(child, anonymous)) }
}

function cost(plan) {
  return [(plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0), plan.Plan['Actual Total Time'] ?? 0]
}

export async function compactPlanLog(input, output, { maximumBytes = 67108864 } = {}) {
  const inputs = Array.isArray(input) ? input : [input]
  assert.ok(inputs.length > 0, 'At least one plan input is required')
  assert.ok(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'A positive capture limit is required')
  for (const file of inputs) assert.notEqual(path.resolve(file), path.resolve(output), 'Keep the raw plan log')
  const representatives = new Map()
  const identifiers = new Set()
  let records = 0, plans = 0, missingIdentifiers = 0, retainedBytes = 0
  for (const file of inputs) {
    const source = createReadStream(file)
    const stream = file.endsWith('.gz') ? source.pipe(createGunzip()) : source
    source.on('error', error => stream.destroy(error))
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        records++
        const record = JSON.parse(line)
        const database = record.dbname ?? record.database_name ?? null
        for (const plan of jsonLoggedPlans(line)) {
          plans++
          const identifier = plan['Query Identifier']
          const unidentified = identifier == null || BigInt(identifier) === 0n
          if (unidentified) missingIdentifiers++
          else identifiers.add(JSON.stringify([database, BigInt.asIntN(64, BigInt(identifier)).toString()]))
          const anonymous = unidentified && !plan['Query Text']?.trim()
          const key = JSON.stringify([database, identifier ?? null, unidentified ? plan['Query Text'] : null,
            anonymous ? record.context : null, shape(plan.Plan, anonymous)])
          const previous = representatives.get(key)
          const entry = { line, rank: cost(plan) }
          const next = {
            buffers: !previous || entry.rank[0] > previous.buffers.rank[0] || entry.rank[0] === previous.buffers.rank[0] && entry.rank[1] > previous.buffers.rank[1] ? entry : previous.buffers,
            time: !previous || entry.rank[1] > previous.time.rank[1] || entry.rank[1] === previous.time.rank[1] && entry.rank[0] > previous.time.rank[0] ? entry : previous.time,
          }
          retainedBytes += Buffer.byteLength(next.buffers.line) + Buffer.byteLength(next.time.line)
            - (previous ? Buffer.byteLength(previous.buffers.line) + Buffer.byteLength(previous.time.line) : 0)
          assert.ok(retainedBytes <= maximumBytes, 'Retained plans exceed the capture limit')
          representatives.set(key, next)
        }
      }
    } finally {
      lines.close()
      stream.destroy()
      source.destroy()
    }
  }
  const retained = new Set([...representatives.values()].flatMap(group => [group.buffers.line, group.time.line]))
  const outputLines = function* () {
    for (const line of retained) yield `${line}\n`
  }
  const destination = createWriteStream(output, { mode: 0o600 })
  await pipeline([Readable.from(outputLines()), ...(output.endsWith('.gz') ? [createGzip()] : []), destination])
  return { records, plans, queryIdentifiers: identifiers.size, planShapes: representatives.size, retainedPlans: retained.size,
    missingIdentifiers, identified: plans > 0 && missingIdentifiers === 0,
    inputBytes: (await Promise.all(inputs.map(file => stat(file)))).reduce((sum, row) => sum + row.size, 0), outputBytes: (await stat(output)).size }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const multiple = process.argv[2] === '--inputs'
  assert.equal(process.argv.length, multiple ? 5 : 4, 'Use compact-plans [--inputs MANIFEST.json | INPUT.jsonl[.gz]] OUTPUT.jsonl[.gz]')
  const input = multiple ? JSON.parse(await readFile(process.argv[3], 'utf8')) : process.argv[2]
  const result = await compactPlanLog(input, process.argv[multiple ? 4 : 3])
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.identified) process.exitCode = 1
}
