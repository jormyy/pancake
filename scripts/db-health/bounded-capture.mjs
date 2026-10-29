import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createGunzip, createGzip } from 'node:zlib'
import { compactPlanLog } from './compact-plans.mjs'
import { summarizePlanLog } from './plan-summary.mjs'

function mergeSummaries(before, after) {
  if (!before) return after
  assert.equal(before.database, after.database)
  const result = { ...before }
  for (const key of ['ignoredRecords', 'unattributedRecords', 'anonymousPlans', 'capturedPlans', 'spilledPlans']) result[key] += after[key]
  const queries = new Map(before.queries.map(row => [row.query, { ...row }]))
  for (const row of after.queries) {
    const previous = queries.get(row.query)
    if (!previous) { queries.set(row.query, row); continue }
    for (const key of ['calls', 'milliseconds', 'buffers']) previous[key] += row[key]
    if (row.maximumBuffers > previous.maximumBuffers) { previous.maximumBuffers = row.maximumBuffers; previous.sample = row.sample }
    if (row.maximumMilliseconds > previous.maximumMilliseconds) { previous.maximumMilliseconds = row.maximumMilliseconds; previous.slowestSample = row.slowestSample }
  }
  result.queries = [...queries.values()].sort((a, b) => b.milliseconds - a.milliseconds)
  result.distinctQueries = queries.size
  const indexes = new Map(before.indexes.map(row => [row.name, row.calls]))
  for (const row of after.indexes) indexes.set(row.name, (indexes.get(row.name) ?? 0) + row.calls)
  result.indexes = [...indexes].map(([name, calls]) => ({ name, calls }))
  const scans = new Map(before.scans.map(row => [`${row.type}:${row.relation}`, { ...row }]))
  for (const row of after.scans) {
    const key = `${row.type}:${row.relation}`, previous = scans.get(key)
    if (!previous) { scans.set(key, row); continue }
    previous.calls += row.calls
    previous.maximumRows = Math.max(previous.maximumRows, row.maximumRows)
    previous.maximumExaminedRows = Math.max(previous.maximumExaminedRows, row.maximumExaminedRows)
  }
  result.scans = [...scans.values()].sort((a, b) => b.maximumExaminedRows - a.maximumExaminedRows)
  return result
}

export async function summarizeCapture(input, directory, before, after = null, { maximumBytes = 67108864 } = {}) {
  assert.equal(before.database, 'postgres')
  if (after) assert.equal(after.database, before.database)
  const start = Date.parse(before.capturedAt), end = after ? Date.parse(after.capturedAt) : Infinity
  assert.ok(Number.isFinite(start) && end >= start)
  assert.ok((await stat(input)).size <= maximumBytes, 'A capture segment exceeds the file limit')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stateFile = path.join(directory, 'state.json')
  let state = { generation: 0, processed: [], summary: null }
  try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (state.captureStart) assert.equal(state.captureStart, before.capturedAt, 'A capture cannot reuse another time interval')
  const hash = createHash('sha256')
  for await (const block of createReadStream(input)) hash.update(block)
  const sha256 = hash.digest('hex')
  if (state.processed.some(row => row.name === path.basename(input) && row.sha256 === sha256)) { await unlink(input); return state }
  const generation = state.generation + 1
  const filtered = path.join(directory, `filtered-${generation}.jsonl.gz`)
  const retained = path.join(directory, `retained-${generation}.jsonl.gz`)
  const source = createReadStream(input), stream = input.endsWith('.gz') ? source.pipe(createGunzip()) : source
  source.on('error', error => stream.destroy(error))
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  async function* selected() {
    try {
      for await (const line of lines) {
        assert.ok(Buffer.byteLength(line) <= maximumBytes, 'A log record exceeds the file limit')
        if (!line.trim()) continue
        const row = JSON.parse(line), timestamp = Date.parse(row.timestamp)
        if ((row.dbname ?? row.database_name) === before.database && Number.isFinite(timestamp) && timestamp >= start && timestamp <= end) yield `${line}\n`
      }
    } finally { lines.close(); stream.destroy(); source.destroy() }
  }
  await pipeline(Readable.from(selected()), createGzip(), createWriteStream(filtered, { mode: 0o600 }))
  const summary = mergeSummaries(state.summary, await summarizePlanLog(filtered, before.database))
  const inputs = [...(state.retained ? [path.join(directory, state.retained)] : []), filtered]
  const compaction = await compactPlanLog(inputs, retained, { maximumBytes })
  const next = { captureStart: before.capturedAt, generation, retained: path.basename(retained), summary, compaction,
    processed: [...state.processed, { name: path.basename(input), sha256, bytes: (await stat(input)).size }] }
  const temporary = `${stateFile}.tmp`
  const serialized = `${JSON.stringify(next)}\n`
  assert.ok(Buffer.byteLength(serialized) <= maximumBytes, 'Capture summaries exceed the file limit')
  await writeFile(temporary, serialized, { mode: 0o600 })
  await rename(temporary, stateFile)
  await unlink(input)
  await unlink(filtered)
  if (state.retained) await unlink(path.join(directory, state.retained))
  return next
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [input, directory, beforePath, afterPath] = process.argv.slice(2)
  const result = await summarizeCapture(input, directory, JSON.parse(await readFile(beforePath, 'utf8')),
    afterPath ? JSON.parse(await readFile(afterPath, 'utf8')) : null)
  process.stdout.write(`${JSON.stringify({ generation: result.generation, retained: result.retained, capturedPlans: result.summary.capturedPlans })}\n`)
}
