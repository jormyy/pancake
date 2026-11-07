import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const execute = promisify(execFile)
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const maximumBytes = 2 * 1024 * 1024

export function summary(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measurement')
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95), min: sorted[0], max: sorted.at(-1) }
}

export async function readBody(response) {
  if (!response.body) throw new Error('Missing response body')
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) throw new Error('Response exceeds measurement limit')
      chunks.push(value)
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks))
    let body
    try { body = JSON.parse(text) } catch { throw new Error('Public response is not JSON') }
    return { body, bytes }
  } finally {
    await reader.cancel()
  }
}

export async function measure(plan, dependencies) {
  const { request, counter, wait = pause, clock = () => performance.now(), record = async () => {} } = dependencies
  const samples = []
  let lastStarted = -Infinity
  for (const entry of plan.cases) {
    for (let round = -plan.warmup; round < plan.samples; round++) {
      let cursor = null
      for (let page = 1; page <= plan.pages; page++) {
        await wait(Math.max(0, plan.intervalMs - (clock() - lastStarted)))
        const before = counter ? await counter() : null
        const started = clock()
        lastStarted = started
        const response = await request(entry, cursor)
        if (response.status !== 200) {
          await response.body?.cancel()
          throw new Error(`Measurement stopped at ${entry.resource}: HTTP ${response.status}`)
        }
        const { body, bytes } = await readBody(response)
        const latencyMs = clock() - started
        const after = counter ? await counter() : null
        if (counter && (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after <= before)) {
          throw new Error('Database counter did not increase; check isolation and statistics tracking')
        }
        if (body.version !== 1 || body.resource !== entry.resource || !Array.isArray(body.items)
          || body.items.length > plan.limit || !(body.nextCursor === null || typeof body.nextCursor === 'string')) {
          throw new Error('Invalid public response envelope')
        }
        const sample = { resource: entry.resource, round, page, latencyMs, bytes, items: body.items.length,
          databaseStatements: counter ? after - before : null, more: body.nextCursor !== null }
        if (round >= 0) { samples.push(sample); await record(sample) }
        if (body.nextCursor === null) break
        if (body.nextCursor === cursor) throw new Error('Repeated pagination cursor')
        cursor = body.nextCursor
      }
    }
  }
  return samples
}

export function summarize(samples) {
  return [...new Set(samples.map(sample => `${sample.resource}:${sample.page}`))].map(key => {
    const selected = samples.filter(sample => `${sample.resource}:${sample.page}` === key)
    return { resource: selected[0].resource, page: selected[0].page,
      latencyMs: summary(selected.map(sample => sample.latencyMs)),
      responseBytes: summary(selected.map(sample => sample.bytes)),
      databaseStatements: selected.every(sample => sample.databaseStatements !== null)
        ? summary(selected.map(sample => sample.databaseStatements)) : null,
      returnedItems: summary(selected.map(sample => sample.items)) }
  })
}

async function databaseCounter(connection) {
  const database = new URL(connection)
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) {
    throw new Error('Database measurement requires a loopback disposable stack')
  }
  const env = { ...process.env, PGHOST: database.hostname.replace(/^\[|\]$/g, ''), PGPORT: database.port || '5432',
    PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password),
    PGDATABASE: database.pathname.slice(1), PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000',
    PGSERVICE: '', PGSERVICEFILE: '', PGPASSFILE: '/dev/null' }
  delete env.PANCAKE_TOKEN
  delete env.PANCAKE_PERF_DB_URL
  return async () => {
    let stdout
    try {
      ({ stdout } = await execute('psql', ['-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT json_build_object('marker','pancake_public_perf_counter','track',current_setting('pg_stat_statements.track'),'calls',coalesce(sum(calls),0)) FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT ILIKE '%pg_stat_statements%'"],
      { env, timeout: 10000, maxBuffer: 1024 * 1024 }))
    } catch { throw new Error('Cannot read local database statement counters') }
    const value = JSON.parse(stdout)
    if (value.track !== 'all') throw new Error('Set pg_stat_statements.track to all on the disposable stack')
    return Number(value.calls)
  }
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).map(argument => {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument)
    if (!match) throw new Error('Use --name=value options')
    return match.slice(1)
  }))
  for (const key of Object.keys(options)) if (!['api-url', 'output', 'cases', 'samples', 'warmup', 'pages', 'limit', 'interval-ms', 'live'].includes(key)) throw new Error('Unknown measurement option')
  const integer = (key, fallback, minimum, maximum) => {
    const value = options[key] ?? String(fallback)
    if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`Invalid --${key}`)
    return Number(value)
  }
  const url = new URL(options['api-url'] ?? process.env.PANCAKE_API_URL)
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((!local && !(options.live === 'true' && url.protocol === 'https:')) || url.username || url.password || url.search || url.hash) throw new Error('Use a loopback API or explicitly approved --live=true HTTPS URL')
  const token = process.env.PANCAKE_TOKEN
  if (!/^[a-f0-9]{64}$/i.test(token ?? '')) throw new Error('Set PANCAKE_TOKEN to an approved league share token')
  const schema = JSON.parse(await readFile(new URL('../../packages/pancake-cli/schemas/v1.json', import.meta.url), 'utf8'))
  const cases = options.cases ? JSON.parse(await readFile(options.cases, 'utf8')) : Object.keys(schema.resources).map(resource => ({ resource,
    query: resource === 'rosters' ? { team: process.env.PANCAKE_TEAM_ID } : {} }))
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 100 || cases.some(entry => !schema.resources[entry.resource]
    || !entry.query || typeof entry.query !== 'object' || Array.isArray(entry.query)
    || Object.keys(entry.query).some(key => !['team', 'player', 'season', 'week', 'query', 'position'].includes(key))
    || Object.values(entry.query).some(value => typeof value !== 'string' || value.length > 100)
    || (entry.resource === 'rosters' && !entry.query.team))) throw new Error('Supply public resource cases and a roster team')
  const plan = { cases, samples: integer('samples', 30, 1, 1000), warmup: integer('warmup', 2, 0, 20),
    pages: integer('pages', 3, 1, 100), limit: integer('limit', 25, 1, 50), intervalMs: integer('interval-ms', 1100, 1100, 60000) }
  if (local && !process.env.PANCAKE_PERF_DB_URL) throw new Error('Set PANCAKE_PERF_DB_URL from the disposable stack for query counts')
  if (!local && process.env.PANCAKE_PERF_DB_URL) throw new Error('Live reads cannot use a local database counter')
  const counter = local ? await databaseCounter(process.env.PANCAKE_PERF_DB_URL) : null
  const output = path.resolve(options.output ?? '.cache/public-cli-perf')
  await mkdir(output, { recursive: true })
  const raw = path.join(output, 'samples.jsonl')
  await writeFile(raw, '', { mode: 0o600, flag: 'wx' })
  const report = { version: 1, startedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform,
    arch: process.arch, endpoint: local ? 'local Supabase' : url.origin, databaseCounter: local ? 'pg_stat_statements.track=all; includes nested and outer statements' : 'not available' },
    plan, harnessSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    assumptions: ['Disposable isolated stack; cron and other clients stopped', 'Stable seeded data and public token for all runs', 'HTTP body consumed before timing stops', 'No retries or conditional requests', 'Counter excludes statistics introspection queries'],
    samples: 0, metrics: [], error: null }
  try {
    const samples = await measure(plan, { counter,
      request: (entry, cursor) => {
        const query = new URLSearchParams({ ...entry.query, limit: String(plan.limit), ...(cursor ? { cursor } : {}) })
        return fetch(`${url.href.replace(/\/+$/, '')}/public/v1/${entry.resource}?${query}`, {
          headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) })
      },
      record: async sample => { await writeFile(raw, `${JSON.stringify(sample)}\n`, { flag: 'a' }); report.samples++ },
    })
    report.metrics = summarize(samples)
  } catch (error) {
    report.error = error instanceof Error && !error.message.includes(token) ? error.message : 'Measurement failed'
    process.exitCode = 1
  } finally {
    await writeFile(path.join(output, 'report.json'), `${JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  }
  process.stdout.write(`${JSON.stringify({ samples: report.samples, complete: report.error === null })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Public measurement setup failed; check the approved local configuration.\n'); process.exitCode = 1 })
}
