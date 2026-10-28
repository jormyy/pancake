#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const contract = JSON.parse(readFileSync(new URL('../schemas/v1.json', import.meta.url), 'utf8'))

const exitCodes = { success: 0, usage: 2, auth: 3, missing: 4, limited: 5, network: 6, server: 7, operator: 8 }
const resources = Object.keys(contract.resources)
const filters = ['limit', 'cursor', 'season', 'week', 'team', 'player', 'query', 'position']
const values = new Set([...filters, 'api-url', 'token', 'fixture', 'cache-dir', 'operator-connection'])
const flags = new Set(['json', 'text', 'no-cache', 'help', 'version'])
class CliError extends Error {
  constructor(message, code) { super(message); this.code = code }
}
function parse(args) {
  const options = {}
  const positional = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (!argument.startsWith('--')) { positional.push(argument); continue }
    const [key, ...rest] = argument.slice(2).split('=')
    if (Object.hasOwn(options, key) || (!values.has(key) && !flags.has(key))) throw new CliError(`Unknown or repeated option: --${key}`, 2)
    if (flags.has(key)) {
      if (rest.length) throw new CliError(`--${key} takes no value`, 2)
      options[key] = true
    } else {
      const value = rest.length ? rest.join('=') : args[++index]
      if (!value || value.startsWith('--')) throw new CliError(`--${key} needs a value`, 2)
      options[key] = value
    }
  }
  if (options.json && options.text) throw new CliError('Choose --json or --text', 2)
  return { options, positional }
}
function description(name) {
  const selected = name ? { [name]: contract.resources[name] } : contract.resources
  if (name && !contract.resources[name]) throw new CliError('Unknown resource', 2)
  return { $schema: 'urn:pancake:cli:v1:description', version: 1,
    commands: [...resources, 'describe', 'explain', 'db-health'], filters,
    options: [...values, ...flags], exitCodes, schemas: selected }
}
function explain(target) {
  if (!target) throw new CliError('Use explain <resource> or explain <resource.field>', 2)
  const [name, ...fields] = target.split('.')
  let schema = contract.resources[name]?.properties.items.items
  if (!schema) throw new CliError('Unknown resource', 2)
  for (const field of fields) {
    schema = schema.properties?.[field]
    if (!schema) throw new CliError('Unknown field', 2)
  }
  return { $schema: 'urn:pancake:cli:v1:explanation', version: 1, object: target, definition: schema }
}
function validate(value, schema) {
  if (schema.const !== undefined && value !== schema.const) throw new CliError('Response schema does not match', 7)
  if (schema.enum && !schema.enum.includes(value)) throw new CliError('Response contains an invalid field', 7)
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (value === null && types.includes('null')) return
  if (schema.properties) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('Invalid response object', 7)
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new CliError('Unexpected response field', 7)
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) throw new CliError('Missing response field', 7)
      validate(value[key], schema.properties[key])
    }
  } else if (schema.items) {
    if (!Array.isArray(value)) throw new CliError('Invalid response list', 7)
    value.forEach(item => validate(item, schema.items))
  } else if (schema.type && !types.includes(typeof value) && !(types.includes('integer') && Number.isSafeInteger(value))) {
    throw new CliError('Invalid response field type', 7)
  }
}
function numberOption(value, fallback, max) {
  if (value === undefined) return fallback
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new CliError('Invalid numeric filter', 2)
  return Number(value)
}
function queryOptions(options, name) {
  const params = new URLSearchParams()
  numberOption(options.limit, 25, 50)
  numberOption(options.week, 1, 60)
  numberOption(options.season, 1, 2200)
  for (const key of ['team', 'player']) if (options[key] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options[key])) throw new CliError(`Invalid --${key}`, 2)
  if (name === 'rosters' && !options.team) throw new CliError('rosters requires --team; use standings to find team IDs', 2)
  const supported = { season: ['league', 'rosters', 'matchups', 'scores', 'schedule', 'draft-results', 'player-stats'], week: ['matchups', 'scores', 'schedule'], team: ['rosters', 'standings', 'matchups', 'scores', 'schedule', 'transactions'],
    player: ['player-stats', 'projections'], query: ['player-stats', 'projections'], position: ['player-stats', 'projections'] }
  for (const [filter, commands] of Object.entries(supported)) if (options[filter] !== undefined && !commands.includes(name)) throw new CliError(`--${filter} is not supported for ${name}`, 2)
  for (const filter of filters) if (options[filter] !== undefined) params.set(filter, options[filter])
  params.sort()
  return params
}
async function fixtureRead(filename, name, params) {
  const fixture = JSON.parse(await readFile(filename, 'utf8'))
  let items = fixture.resources[name].items
  if (params.has('team')) items = items.filter(item => item.teamId === params.get('team') || item.homeTeamId === params.get('team') || item.awayTeamId === params.get('team'))
  if (params.has('player')) items = items.filter(item => item.id === params.get('player'))
  if (params.has('query')) items = items.filter(item => (item.name ?? '').toLowerCase().includes(params.get('query').toLowerCase()))
  if (params.has('position')) items = items.filter(item => item.position === params.get('position'))
  if (params.has('week')) items = items.filter(item => item.weekNumber <= Number(params.get('week')) && item.endWeekNumber >= Number(params.get('week')))
  if (params.has('season')) items = items.filter(item => item.seasonYear === undefined || item.seasonYear === Number(params.get('season')))
  let offset = 0
  if (params.has('cursor')) {
    try {
      const cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64').toString())
      if (cursor.resource !== name || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('Invalid cursor')
      offset = cursor.offset
    } catch { throw new CliError('Invalid fixture cursor', 2) }
  }
  const limit = Number(params.get('limit') ?? 25)
  return { $schema: `urn:pancake:public:v1:${name}`, version: 1, resource: name,
    items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? Buffer.from(JSON.stringify({ resource: name, offset: offset + limit })).toString('base64') : null }
}
async function trimCache(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).map(async entry => ({ file: path.join(directory, entry.name), time: (await stat(path.join(directory, entry.name))).mtimeMs })))
  files.sort((a, b) => b.time - a.time || a.file.localeCompare(b.file))
  await Promise.all(files.slice(128).map(entry => unlink(entry.file)))
}
async function remoteRead(name, options, params, environment, fetcher) {
  let base
  try { base = new URL(options['api-url'] ?? environment.PANCAKE_API_URL) } catch { throw new CliError('Set PANCAKE_API_URL or --api-url', 2) }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
    (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new CliError('Use HTTPS or a loopback HTTP API URL', 2)
  const token = options.token ?? environment.PANCAKE_TOKEN
  if (!/^[a-f0-9]{64}$/i.test(token ?? '')) throw new CliError('Set PANCAKE_TOKEN or --token to a league share token', 3)
  const url = `${base.href.replace(/\/+$/, '')}/public/v1/${name}?${params}`
  const directory = options['cache-dir'] ?? path.join(homedir(), '.cache', 'pancake')
  const key = createHash('sha256').update(`${url}\n${token.toLowerCase()}`).digest('hex')
  const filename = path.join(directory, `${key}.json`)
  let cached
  if (!options['no-cache']) {
    try {
      cached = JSON.parse(await readFile(filename, 'utf8'))
      validate(cached.body, contract.resources[name])
      if (typeof cached.etag !== 'string') cached = undefined
    } catch { cached = undefined }
  }
  let response
  try {
    response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, ...(cached ? { 'If-None-Match': cached.etag } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15000) })
  } catch { throw new CliError('Could not reach the public API', 6) }
  if (response.status === 304 && cached) return cached.body
  if (!response.ok) {
    const status = response.status
    throw new CliError(status === 429 ? `Read limit reached; retry after ${response.headers.get('retry-after') ?? '60'} seconds` : `Public API returned ${status}`,
      status === 401 || status === 403 ? 3 : status === 404 ? 4 : status === 429 ? 5 : status === 400 ? 2 : 7)
  }
  let body
  try { body = await response.json() } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error instanceof TypeError) throw new CliError('Could not read the public API response', 6)
    throw new CliError('Public API returned invalid JSON', 7)
  }
  validate(body, contract.resources[name])
  if (!options['no-cache'] && response.headers.has('etag')) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(filename, JSON.stringify({ etag: response.headers.get('etag'), body }), { mode: 0o600 })
      await trimCache(directory)
    } catch { }
  }
  return body
}
function operatorHealth(connection) {
  if (!connection) throw new CliError('db-health is private; supply --operator-connection', 2)
  const query = `SELECT jsonb_build_object('database', current_database(), 'connections', (SELECT numbackends FROM pg_stat_database WHERE datname=current_database()), 'tables', (SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', schemaname, 'table', relname, 'liveRows', n_live_tup, 'deadRows', n_dead_tup, 'lastAutovacuum', last_autovacuum) ORDER BY n_dead_tup DESC, schemaname, relname), '[]'::jsonb) FROM pg_stat_user_tables))`;
  const result = spawnSync('psql', [connection, '-w', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000' } })
  if (result.status !== 0) throw new CliError('Operator health query failed', 8)
  try { return { $schema: 'urn:pancake:operator:v1:health', version: 1, private: true, report: JSON.parse(result.stdout) } }
  catch { throw new CliError('Invalid operator health report', 8) }
}
export async function run(args, io = {}) {
  const output = io.stdout ?? process.stdout
  const errors = io.stderr ?? process.stderr
  const environment = io.env ?? process.env
  const fetcher = io.fetch ?? fetch
  let json = !output.isTTY
  try {
    const { options, positional } = parse(args)
    json = options.json || (!options.text && !output.isTTY)
    const [name, target, ...extra] = positional
    if (extra.length || (target && !['describe', 'explain'].includes(name))) throw new CliError('Unexpected arguments', 2)
    let result
    if (options.version) result = { version: '1.0.0', schemaVersion: 1 }
    else if (options.help || !name || name === 'describe') result = description(target)
    else if (name === 'explain') result = explain(target)
    else if (name === 'db-health') result = operatorHealth(options['operator-connection'])
    else if (resources.includes(name)) {
      const params = queryOptions(options, name)
      result = options.fixture ? await fixtureRead(options.fixture, name, params) : await remoteRead(name, options, params, environment, fetcher)
      validate(result, contract.resources[name])
    } else throw new CliError(`Unknown command: ${name}`, 2)
    if (json) output.write(`${JSON.stringify(result)}\n`)
    else if (result.items) output.write(result.items.map(item => Object.entries(item).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join('  ')).join('\n') + `\n${result.nextCursor ? `nextCursor=${result.nextCursor}\n` : ''}`)
    else output.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    const code = error instanceof CliError ? error.code : 7
    const message = error instanceof CliError ? error.message : 'Could not read public data'
    errors.write(json ? `${JSON.stringify({ $schema: 'urn:pancake:cli:v1:error', version: 1, error: { code, message } })}\n` : `${message}\n`)
    return code
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await run(process.argv.slice(2))
