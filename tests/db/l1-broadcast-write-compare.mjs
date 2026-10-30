import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { beginConcurrentRun } from './l1-realtime-concurrency.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const [label] = process.argv.slice(2)
assert.match(label ?? '', /^[a-z0-9-]+$/)
const migrations = await Promise.all(['20261214004000_live_broadcast.sql', '20261214004010_coalesce_live_hints.sql']
  .map(file => readFile(`supabase/migrations/${file}`, 'utf8')))
const tables = [...migrations[0].matchAll(/CREATE TRIGGER broadcast_live_change AFTER INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)/g)].map(match => match[1])
assert.equal(tables.length, 16)
const definitions = migrations.map(text => text.match(/CREATE OR REPLACE FUNCTION private\.broadcast_live_change\(\)[\s\S]*?\$\$;/)?.[0])
assert.ok(definitions.every(Boolean))
const original = await sql("SELECT pg_get_functiondef('private.broadcast_live_change()'::regprocedure)")
const release = await beginConcurrentRun()
const results = { postgres: [], unbatched: [], compact: [] }
const messageInserts = result => result.statements.filter(row => /INSERT INTO realtime\.messages/i.test(row.query.replaceAll('"', '')))
const progress = value => writeFile(`${labRoot}/write-cost-progress.json`, JSON.stringify({ label, pid: process.pid, ...value }))
try {
  for (let round = 1; round <= 5; round++) {
    for (const mode of round % 2 ? ['postgres', 'unbatched', 'compact'] : ['compact', 'unbatched', 'postgres']) {
      await progress({ status: 'running', mode, round })
      await sql(definitions[mode === 'unbatched' ? 0 : 1])
      await sql(tables.map(table => `ALTER TABLE public.${table} ${mode === 'postgres' ? 'DISABLE' : 'ENABLE'} TRIGGER broadcast_live_change;`).join('\n'))
      const name = `${label}-${mode}-${round}`
      await command(process.execPath, ['tests/db/l1-broadcast-write-cost.mjs', name, '200'], { timeout: 120000 })
      const result = JSON.parse(await readFile(`${labRoot}/evidence/${name}.json`, 'utf8'))
      assert.equal(result.writes, 200)
      assert.equal(result.messages, 200 * (mode === 'postgres' ? 0 : mode === 'unbatched' ? 2 : 1))
      assert.equal(messageInserts(result).reduce((sum, row) => sum + row.calls, 0), result.messages)
      results[mode].push(result)
    }
  }
  const stats = values => {
    assert.equal(values.length, 5)
    const sorted = values.toSorted((a, b) => a - b)
    return { median: sorted[2], min: sorted[0], max: sorted[4], spread: sorted[4] - sorted[0] }
  }
  const fields = {
    dbMs: result => result.dbMsPerWrite,
    walBytes: result => result.walBytesPerWrite,
    payloadBytes: result => result.payloadBytes / result.writes,
    messages: result => result.messages / result.writes,
    buffers: result => result.buffers / result.writes,
    cpuMs: result => result.cpuSeconds * 1000 / result.writes,
    insertMs: result => messageInserts(result).reduce((sum, row) => sum + row.dbMs, 0) / result.writes,
    insertWalBytes: result => messageInserts(result).reduce((sum, row) => sum + row.walBytes, 0) / result.writes,
    insertBuffers: result => messageInserts(result).reduce((sum, row) => sum + row.buffers, 0) / result.writes,
  }
  const summary = { label, pairs: 5, writesPerSegment: 200, concurrentLanes: true, measurementLock: false,
    source: (await command('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    metrics: Object.fromEntries(Object.entries(fields).map(([field, read]) => [field, {
      ...Object.fromEntries(Object.entries(results).map(([mode, captures]) => [mode, stats(captures.map(read))])),
      compactMinusPostgres: results.compact.map((result, index) => read(result) - read(results.postgres[index])),
      compactMinusUnbatched: results.compact.map((result, index) => read(result) - read(results.unbatched[index])),
    }])) }
  await writeFile(`${labRoot}/evidence/${label}-summary.json`, JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 })
  await progress({ status: 'complete' })
  console.log(JSON.stringify(summary))
} catch (error) {
  await progress({ status: 'failed', error: error.message })
  throw error
} finally {
  try {
    await sql(original)
    await sql(tables.map(table => `ALTER TABLE public.${table} ENABLE TRIGGER broadcast_live_change;`).join('\n'))
  } finally { await release() }
}
