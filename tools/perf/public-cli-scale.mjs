import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { summary } from './public-cli.mjs'

const execute = promisify(execFile)
const [fixtureFile, outputDirectory, mode = 'verify'] = process.argv.slice(2)
assert(fixtureFile && outputDirectory, 'Use public-cli-scale.mjs FIXTURE_JSON OUTPUT_DIRECTORY [baseline|http]')
const database = new URL(process.env.SUPABASE_DB_URL)
assert(['localhost', '127.0.0.1'].includes(database.hostname), 'Use an isolated loopback database')
const env = { ...process.env, PGHOST: database.hostname, PGPORT: database.port,
  PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password),
  PGDATABASE: database.pathname.slice(1), PGPASSFILE: '/dev/null', PGOPTIONS: '-c statement_timeout=5000' }
delete env.PGSERVICE
delete env.PGSERVICEFILE
const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'))
const policy = JSON.parse(await readFile(new URL('../../supabase/functions/api/public/policy.json', import.meta.url), 'utf8'))
await mkdir(outputDirectory, { recursive: true })
const literal = value => `'${value.replaceAll("'", "''")}'`
const sql = async query => (await execute('psql', ['-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', query], { env, timeout: 7000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
const counter = async () => Number(await sql("SELECT coalesce(sum(calls),0) FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT ILIKE '%pg_stat_statements%'"))
async function request(resource, offset, client) {
  const params = { limit: 50, offset, ...(resource === 'rosters' ? { team: fixture.memberId } : {}) }
  const before = await counter()
  const started = performance.now()
  try {
    let value, bytes
    if (mode === 'http' && client) {
      const base = new URL(process.env.PANCAKE_API_URL)
      assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Use an isolated loopback API')
      const scopeParams = { limit: 50, ...(resource === 'rosters' ? { team: fixture.memberId } : {}) }
      const league = resource === 'leagues' ? null : fixture.leagueId
      const scope = createHash('sha256').update(JSON.stringify([league, resource, Object.entries(scopeParams).sort()])).digest('hex').slice(0, 24)
      const query = new URLSearchParams({ ...scopeParams, ...(league ? { league } : {}), ...(offset ? { cursor: Buffer.from(JSON.stringify({ offset, scope })).toString('base64') } : {}) })
      const response = await fetch(`${base.href.replace(/\/$/, '')}/public/v2/${resource}?${query}`, { headers: { 'cf-connecting-ip': client }, signal: AbortSignal.timeout(6000) })
      const text = await response.text()
      assert.equal(response.status, 200)
      const body = JSON.parse(text)
      assert.equal(body.version, 2)
      assert.equal(body.resource, resource)
      value = { status: response.status, items: body.items, hasMore: body.nextCursor !== null }
      bytes = Buffer.byteLength(text)
    } else {
      value = JSON.parse(await sql(`SELECT public.public_read_v2(${literal(fixture.leagueId)}::uuid,${literal(resource)},${literal(JSON.stringify(params))}::jsonb,repeat('a',64))`))
      bytes = Buffer.byteLength(JSON.stringify(value))
    }
    const latencyMs = performance.now() - started
    assert.equal(value.status, 200)
    assert(Array.isArray(value.items) && value.items.length <= 50)
    return { latencyMs, databaseStatements: await counter() - before, bytes, value }
  } catch (error) {
    return { latencyMs: performance.now() - started, error: error.message.includes('statement timeout') ? 'statement timeout' : error.message.slice(0, 200) }
  }
}
const samples = []
await writeFile(path.join(outputDirectory, 'samples.jsonl'), '')
const resources = mode === 'baseline' ? ['projections'] : Object.keys(policy.resources)
const cases = []
for (const resource of resources) {
  let last = 2950
  if (mode !== 'baseline') {
    for (let offset = 0; ; offset += 50) {
      const result = await request(resource, offset)
      assert(!result.error, `${resource} discovery: ${result.error}`)
      if (!result.value.hasMore) { last = offset; break }
      assert(offset < 100000, 'Pagination must terminate')
    }
  }
  for (const [page, offset] of [['first', 0], ['middle', Math.floor(last / 100) * 50], ['last', last]]) cases.push({ resource, page, offset })
}
for (const [index, entry] of cases.entries()) {
  for (let round = mode === 'baseline' ? 0 : -2; round < (mode === 'baseline' ? 1 : 30); round++) {
    const result = await request(entry.resource, entry.offset, `198.18.0.${index + 1}`)
    const sample = { ...entry, round, ...result }
    delete sample.value
    if (round >= 0) {
      samples.push(sample)
      await appendFile(path.join(outputDirectory, 'samples.jsonl'), JSON.stringify(sample) + '\n')
    }
    if (mode !== 'baseline') assert(!result.error && result.latencyMs < 2500, `${entry.resource} ${entry.page} must finish within 2.5 seconds: ${JSON.stringify(sample)}`)
  }
  console.log(`${entry.resource} ${entry.page} complete`)
}
const metrics = cases.map(entry => {
  const selected = samples.filter(sample => sample.resource === entry.resource && sample.page === entry.page)
  const completed = selected.filter(sample => !sample.error)
  return { ...entry, completed: completed.length, failures: selected.length - completed.length,
    latencyMs: completed.length ? summary(completed.map(sample => sample.latencyMs)) : null,
    databaseStatements: completed.length ? summary(completed.map(sample => sample.databaseStatements)) : null,
    responseBytes: completed.length ? summary(completed.map(sample => sample.bytes)) : null }
})
const counts = JSON.parse(await sql("SELECT jsonb_build_object('players',(SELECT count(*) FROM public.players),'player_game_stats',(SELECT count(*) FROM public.player_game_stats),'player_projections',(SELECT count(*) FROM public.player_projections))"))
await writeFile(path.join(outputDirectory, 'report.json'), JSON.stringify({ label: 'fixture/local-stack', mode,
  host: process.platform + '/' + process.arch, counts, statementTimeoutMs: 5000,
  ceilingMs: 2500, warmups: mode === 'baseline' ? 0 : 2, samplesPerCase: mode === 'baseline' ? 1 : 30,
  transport: mode === 'http' ? 'Unauthenticated loopback Edge HTTP; synthetic client per case; counters exclude introspection' : 'Loopback psql; read timer includes client startup and response consumption; counters exclude introspection', metrics }, null, 2) + '\n')
