import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'
import { localKeys, sql } from '../../scripts/season-sim/local-stack.mjs'
import { setClock } from '../../scripts/season-sim/clock.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))
const keys = localKeys()
process.env.SUPABASE_URL = keys.API_URL
process.env.SUPABASE_DB_URL = keys.DB_URL
const invocation = randomUUID()
const rounds = []
await setClock({ at: '2026-10-29T20:30:00.000Z', install: true, rate: 0 })
try {
  await sql(`INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,invocation_key,payload)
    VALUES((SELECT kind FROM private.work_kinds WHERE function_name='sync-player-injuries' LIMIT 1),'l4c-lease-${invocation}','running',gen_random_uuid(),now()+interval '5 minutes','${invocation}',
    jsonb_build_object('l4cLeaseBench','${invocation}'))`)
  for (let round = -1; round < 5; round++) {
    for (const variant of round % 2 === 0 ? ['candidate', 'reference'] : ['reference', 'candidate']) {
      const calls = variant === 'reference' ? 101 : 2
      const output = await sql(`BEGIN;
        EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
        CREATE TEMP TABLE l4c_receipts ON COMMIT DROP AS
        SELECT public.renew_work_lease('${invocation}') AS held FROM generate_series(1,${calls});
        SELECT jsonb_build_object('work',(SELECT md5(to_jsonb(w)::text) FROM private.work_items w WHERE invocation_key='${invocation}'),
          'held',(SELECT bool_and(held) FROM l4c_receipts),'calls',(SELECT count(*) FROM l4c_receipts));
        ROLLBACK;`)
      const boundary = output.lastIndexOf('\n{')
      const plan = JSON.parse(output.slice(0, boundary))[0]
      const receipt = JSON.parse(output.slice(boundary + 1))
      assert.equal(receipt.held, true)
      assert.equal(receipt.calls, calls)
      const hash = receipt.work
      if (round >= 0) rounds.push({ round, variant, calls, databaseMs: plan['Execution Time'], hash })
    }
  }
  for (let round = 0; round < 5; round++) {
    const pair = rounds.filter(row => row.round === round)
    assert.equal(pair[0].hash, pair[1].hash)
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summary = Object.fromEntries(['reference', 'candidate'].map(variant => [variant, {
    calls: variant === 'reference' ? 101 : 2,
    medianDatabaseMs: median(rounds.filter(row => row.variant === variant).map(row => row.databaseMs)),
  }]))
  await mkdir(path.join(miniRoot, 'evidence'), { recursive: true })
  await writeFile(path.join(miniRoot, 'evidence/lease-pairs.json'), `${JSON.stringify({ identities: 100, rounds, summary }, null, 2)}\n`)
  console.log(JSON.stringify(summary))
} finally {
  await sql(`DELETE FROM private.work_items WHERE invocation_key='${invocation}'`)
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}
