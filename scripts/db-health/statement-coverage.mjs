import { createReadStream, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'
import { jsonLoggedPlans } from './plan-summary.mjs'

function queryId(value) {
  if (value == null) return null
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('A rounded query identifier cannot prove coverage')
  const id = BigInt.asIntN(64, BigInt(value))
  return id === 0n ? null : id.toString()
}

function countedPlan(captured, plan) {
  const id = queryId(plan['Query Identifier'])
  if (id !== null) captured.set(id, (captured.get(id) ?? 0) + 1)
}

function checkedDatabase(before, after) {
  if (before.database !== after.database) throw new Error('Statement snapshots come from different databases')
  return before.database
}

export function statementCoverage(before, after, plans) {
  const captured = new Map()
  for (const plan of plans) countedPlan(captured, plan)
  return coverageFromCounts(before, after, captured)
}

export async function statementCoverageFromLog(before, after, file) {
  const database = checkedDatabase(before, after)
  const captured = new Map()
  const start = before.capturedAt == null ? null : Date.parse(before.capturedAt)
  const end = after.capturedAt == null ? null : Date.parse(after.capturedAt)
  if ((start === null) !== (end === null) || start !== null && (!Number.isFinite(start) || !Number.isFinite(end) || end < start)) {
    throw new Error('Statement snapshots need an ordered capture interval')
  }
  let ignoredDatabaseRecords = 0, unattributedPlans = 0, ignoredTimeRecords = 0, untimedPlans = 0
  const source = createReadStream(file)
  const stream = file.endsWith('.gz') ? source.pipe(createGunzip()) : source
  source.on('error', error => stream.destroy(error))
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      const recordedDatabase = record.dbname ?? record.database_name
      if (database && recordedDatabase && recordedDatabase !== database) {
        ignoredDatabaseRecords++
        continue
      }
      if (start !== null) {
        const timestamp = Date.parse(record.timestamp)
        if (!Number.isFinite(timestamp)) {
          for (const ignored of jsonLoggedPlans(line)) { void ignored; untimedPlans++ }
          continue
        }
        if (timestamp < start || timestamp > end) { ignoredTimeRecords++; continue }
      }
      for (const plan of jsonLoggedPlans(line)) {
        if (database && !recordedDatabase) unattributedPlans++
        else countedPlan(captured, plan)
      }
    }
  } finally {
    lines.close()
    stream.destroy()
    source.destroy()
  }
  const result = coverageFromCounts(before, after, captured)
  return { ...result, complete: result.complete && unattributedPlans === 0 && untimedPlans === 0, ignoredDatabaseRecords, unattributedPlans, ignoredTimeRecords, untimedPlans }
}

function coverageFromCounts(before, after, captured) {
  checkedDatabase(before, after)
  if (before.statementStatsResetAt !== after.statementStatsResetAt) throw new Error('Statement counters reset during the workload')
  const key = row => `${row.userId ?? ''}:${row.topLevel}:${queryId(row.queryId)}`
  if (before.statements.length && after.statements.length && (before.statements[0].userId == null) !== (after.statements[0].userId == null)) {
    throw new Error('Statement snapshots need the same role identity fields')
  }
  const previous = new Map(before.statements.map(row => [key(row), row.calls]))
  const statements = after.statements.flatMap(row => {
    const calls = row.calls - (previous.get(key(row)) ?? 0)
    if (calls < 0) throw new Error('Statement counters decrease during the workload')
    if (calls === 0) return []
    const id = queryId(row.queryId)
    const utility = typeof row.query === 'string' && /^\s*(?:begin|commit|rollback|set|reset|show|load|create|alter|drop|grant|revoke|truncate|vacuum|analyze|comment|notify|discard|deallocate|do|explain)\b/i.test(row.query)
    return [{ ...row, workloadCalls: calls, capturedPlans: captured.get(id) ?? 0,
      coverage: captured.has(id) ? 'plan captured' : utility ? 'utility statement' : 'missing plan' }]
  })
  const missing = statements.filter(row => row.coverage === 'missing plan')
  return { complete: missing.length === 0, reviewed: false, statements: statements.length,
    captured: statements.filter(row => row.coverage === 'plan captured').length,
    utilities: statements.filter(row => row.coverage === 'utility statement').length,
    missing: missing.length, rows: statements }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [beforePath, afterPath, plansPath] = process.argv.slice(2)
  const result = await statementCoverageFromLog(JSON.parse(readFileSync(beforePath, 'utf8')), JSON.parse(readFileSync(afterPath, 'utf8')), plansPath)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.complete) process.exitCode = 1
}
