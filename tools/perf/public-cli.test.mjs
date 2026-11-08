import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { databaseCounter, measure, readBody, summarize, summary } from './public-cli.mjs'

const plan = { cases: [{ resource: 'players', query: {} }], samples: 2, warmup: 1, pages: 2, limit: 1, intervalMs: 1100 }
const page = cursor => Response.json({ version: 1, resource: 'players', items: [{ id: 'one' }], nextCursor: cursor })

test('reports nearest-rank percentiles and rejects invalid measurements', () => {
  assert.deepEqual(summary([4, 1, 2, 3]), { n: 4, p50: 2, p95: 4, min: 1, max: 4 })
  assert.throws(() => summary([]))
  assert.throws(() => summary([NaN]))
})

test('excludes warmup, follows pages and records real statement deltas', async () => {
  let time = 0, calls = 0
  const cursors = [], recorded = []
  const samples = await measure(plan, { clock: () => time, wait: async milliseconds => { time += milliseconds },
    counter: async () => calls,
    request: async (_entry, cursor) => { cursors.push(cursor); calls += 7; time += cursor ? 20 : 10; return page(cursor ? null : 'next') },
    record: async sample => { recorded.push(sample) },
  })
  assert.deepEqual(cursors, [null, 'next', null, 'next', null, 'next'])
  assert.equal(samples.length, 4)
  assert.equal(recorded.length, 4)
  assert.deepEqual(samples.map(sample => sample.databaseStatements), [7, 7, 7, 7])
  assert.deepEqual(summarize(samples).map(row => row.latencyMs.p50), [10, 20])
  assert.deepEqual(summarize(samples).map(row => row.page), [1, 2])
})

test('fails when statistics do not see request statements', async () => {
  await assert.rejects(measure(plan, { wait: async () => {}, counter: async () => 4, request: async () => page(null) }), /counter did not increase/)
})

test('fails on server errors instead of silently measuring retries', async () => {
  await assert.rejects(measure(plan, { wait: async () => {}, request: async () => new Response('', { status: 429 }) }), /HTTP 429/)
})

test('fails on a repeated cursor', async () => {
  await assert.rejects(measure(plan, { wait: async () => {}, request: async () => page('same') }), /Repeated pagination cursor/)
})

test('caps buffered responses', async () => {
  await assert.rejects(readBody(new Response('x'.repeat(2 * 1024 * 1024 + 1))), /measurement limit/)
})

test('rejects wrong resource envelopes', async () => {
  await assert.rejects(measure(plan, { wait: async () => {}, request: async () => Response.json({ version: 1, resource: 'trades', items: [], nextCursor: null }) }), /Invalid public response/)
})


test('database counters remove inherited service configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-public-counter-'))
  const original = { PATH: process.env.PATH, PGSERVICE: process.env.PGSERVICE, PGSERVICEFILE: process.env.PGSERVICEFILE }
  try {
    await writeFile(path.join(directory, 'psql'), '#!/usr/bin/env node\nif ("PGSERVICE" in process.env || "PGSERVICEFILE" in process.env) process.exit(1)\nconsole.log(JSON.stringify({ track: "all", calls: 7 }))\n', { mode: 0o700 })
    process.env.PATH = directory + path.delimiter + process.env.PATH
    process.env.PGSERVICE = 'unrelated'
    process.env.PGSERVICEFILE = '/unrelated'
    const counter = await databaseCounter('postgresql://fixture:fixture@127.0.0.1:59422/postgres')
    assert.equal(await counter(), 7)
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
