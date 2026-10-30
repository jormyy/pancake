import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { requireMini, project } from '../../scripts/perf-lab/common.mjs'
import { sql, statementSnapshot } from '../../scripts/perf-lab/database.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const [label, count = '50'] = process.argv.slice(2)
assert.match(label ?? '', /^[a-z0-9-]+$/)
const writes = Number(count)
assert.ok(Number.isInteger(writes) && writes >= 10 && writes <= 500)
const directory = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1/evidence')
const scores = JSON.parse(await readFile(path.join(directory, 'score-fixture.json'), 'utf8'))
assert.equal(scores.length, 5)
for (const row of scores) assert.match(row.id, /^[a-f0-9-]{36}$/)
const update = `UPDATE public.matchups SET home_points=home_points+0.01 WHERE id IN (${scores.map(row => `'${row.id}'`).join(',')});`
await sql(`UPDATE public.matchups matchup SET home_points=original.home_points
  FROM jsonb_populate_recordset(NULL::public.matchups,'${JSON.stringify(scores)}') original WHERE matchup.id=original.id`)
const cpu = () => new Promise((resolve, reject) => {
  http.get({ socketPath: path.join(homedir(), 'pancake-t_4ba51e0d/lima/pancake-dev/sock/docker.sock'),
    path: '/containers/supabase_db_pt4bafablel1/stats?stream=false&one-shot=true' }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => {
      try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks)).cpu_stats.cpu_usage.total_usage) }
      catch (error) { reject(error) }
    })
  }).on('error', reject)
})
const key = row => `${row.queryid}/${row.userid}/${row.dbid}/${row.toplevel}`
const before = new Map((await statementSnapshot()).map(row => [key(row), row]))
const state = async () => JSON.parse(await sql(`SELECT json_build_object('lsn',pg_current_wal_insert_lsn(),
  'messages',(SELECT count(*) FROM realtime.messages WHERE topic LIKE 'l1:%'),
  'payloadBytes',(SELECT coalesce(sum(pg_column_size(payload)),0) FROM realtime.messages WHERE topic LIKE 'l1:%'))`))
const start = await state()
const cpuBefore = await cpu()
const started = performance.now()
await sql(Array.from({ length: writes }, () => update).join('\n'), { measured: true })
const wallMs = performance.now() - started
const end = await state()
const cpuSeconds = (await cpu() - cpuBefore) / 1e9
const walBytes = Number(await sql(`SELECT pg_wal_lsn_diff('${end.lsn}','${start.lsn}')`))
const statements = (await statementSnapshot()).flatMap(row => {
  const previous = before.get(key(row)) ?? {}
  const calls = row.calls - (previous.calls ?? 0)
  if (!calls) return []
  return [{ query: row.query, toplevel: row.toplevel, calls,
    dbMs: row.total_exec_time - (previous.total_exec_time ?? 0),
    walBytes: Number(row.wal_bytes) - Number(previous.wal_bytes ?? 0),
    buffers: row.shared_blks_hit + row.shared_blks_read - (previous.shared_blks_hit ?? 0) - (previous.shared_blks_read ?? 0) }]
})
const sum = (rows, column) => rows.reduce((total, row) => total + row[column], 0)
const writesOnly = statements.filter(row => row.toplevel && row.query.startsWith('UPDATE public.matchups'))
const sends = statements.filter(row => /realtime\.send|INSERT INTO realtime\.messages/.test(row.query))
const result = { label, writes, wallMs, cpuSeconds, walBytes, walBytesPerWrite: walBytes / writes,
  messages: end.messages - start.messages, payloadBytes: end.payloadBytes - start.payloadBytes,
  dbMs: sum(writesOnly, 'dbMs'), dbMsPerWrite: sum(writesOnly, 'dbMs') / writes,
  statementWalBytes: sum(writesOnly, 'walBytes'), buffers: sum(writesOnly, 'buffers'), sends, statements }
await writeFile(path.join(directory, `${label}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ ...result, statements: undefined }))
