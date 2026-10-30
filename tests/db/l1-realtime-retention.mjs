import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { requireMini, project } from '../../scripts/perf-lab/common.mjs'
import { sql, statementSnapshot, statementDelta } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const tenants = JSON.parse(await sql('SELECT json_agg(external_id) FROM _realtime.tenants'))
assert.equal(tenants.length, 1)
assert.match(tenants[0], /^[a-z0-9._-]+$/)
const day = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)
const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10)
const table = `realtime.messages_${day.replaceAll('-', '_')}`
assert.equal(await sql(`SELECT to_regclass('${table}') IS NULL`), 't')
let created = false
try {
  await sql(`CREATE TABLE ${table} PARTITION OF realtime.messages FOR VALUES FROM ('${day}') TO ('${next}')`)
  created = true
  await sql(`INSERT INTO realtime.messages(id,inserted_at,payload,event,topic,private,extension)
    SELECT gen_random_uuid(),'${day}'::timestamp,jsonb_build_object('retention_probe',true,'sample',repeat('x',200)),
      'change','l1:retention:probe',true,'broadcast' FROM generate_series(1,1000)`)
  const bytesBefore = Number(await sql(`SELECT pg_total_relation_size('${table}')`))
  const before = await statementSnapshot()
  const lsn = await sql('SELECT pg_current_wal_insert_lsn()')
  const started = performance.now()
  const result = await command('docker', ['exec', 'supabase_realtime_pt4bafablel1', '/app/bin/realtime', 'rpc',
    `IO.inspect(%{enabled: Application.get_env(:realtime, :run_janitor), result: Realtime.Tenants.Janitor.MaintenanceTask.run(${JSON.stringify(tenants[0])})})`],
  { timeout: 60000 })
  const wallMs = performance.now() - started
  assert.match(result.stdout, /result: :ok/)
  const dropped = await sql(`SELECT to_regclass('${table}') IS NULL`)
  assert.equal(dropped, 't', 'The built-in janitor must drop the expired partition')
  const walBytes = Number(await sql(`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'${lsn}')`))
  const statements = statementDelta(before, await statementSnapshot())
    .filter(row => /^DROP TABLE/i.test(row.query) && row.query.includes(table.split('.')[1]))
  const evidence = { status: 'pass', project, day, probeRows: 1000, bytesBefore, partitionDropped: true,
    janitorEnabled: /enabled: true/.test(result.stdout), wallMs, walBytes,
    dropDbMs: statements.reduce((sum, row) => sum + row.total_exec_time, 0),
    dropBuffers: statements.reduce((sum, row) => sum + row.shared_blks_hit + row.shared_blks_read, 0),
    scope: 'Built-in janitor maintenance RPC on the owned Realtime tenant; wall time includes RPC startup' }
  await writeFile(path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1/evidence/retention.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(evidence))
} finally {
  if (created) await sql(`DROP TABLE IF EXISTS ${table}`)
}
