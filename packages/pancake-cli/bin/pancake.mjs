#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const contract = JSON.parse(readFileSync(new URL('../schemas/v2.json', import.meta.url), 'utf8'))

const supported = JSON.parse(readFileSync(new URL('../schemas/options-v2.json', import.meta.url), 'utf8'))
const maximumBytes = 2 * 1024 * 1024
const exitCodes = { success: 0, usage: 2, missing: 4, limited: 5, network: 6, server: 7 }
const resources = Object.keys(contract.resources)
const filters = ['league', 'limit', 'cursor', 'season', 'week', 'team', 'player', 'draft', 'trade', 'query', 'position', 'sort', 'direction']
const values = new Set([...filters, 'api-url', 'fixture', 'cache-dir'])
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
  return { $schema: 'urn:pancake:cli:v2:description', version: 2,
    commands: [...resources, 'describe', 'explain'], filters,
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
  return { $schema: 'urn:pancake:cli:v2:explanation', version: 2, object: target, definition: schema }
}
function validate(value, schema) {
  if ((typeof value === 'string' && value.length > (schema.maxLength ?? 100000)) || (Array.isArray(value) && value.length > (schema.maxItems ?? 50))) throw new CliError('Response exceeds schema bounds', 7)
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
  for (const key of ['league', 'team', 'player', 'draft', 'trade']) {
    if ((key === 'league' && name !== 'leagues' && !options[key]) || (options[key] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options[key]))) throw new CliError('Public resource not found', 4)
  }
  if (name === 'leagues' && options.league) throw new CliError('leagues does not accept --league', 2)
  if (name === 'rosters' && !options.team) throw new CliError('Public resource not found', 4)
  for (const key of filters) {
    if (options[key] === undefined) continue
    if (!['league','limit','cursor','sort','direction'].includes(key) && !supported[name].filters.includes(key)) throw new CliError(`--${key} is not supported for ${name}`, 2)
    if (key === 'sort' && !supported[name].sorts.includes(options[key])) throw new CliError('Invalid sort field', 2)
    if (key === 'direction' && !['asc','desc'].includes(options[key])) throw new CliError('Invalid sort direction', 2)
    if (['query','position'].includes(key) && (options[key].length > 100 || /[\u0000-\u001f]/.test(options[key]))) throw new CliError('Invalid text filter', 2)
    params.set(key, options[key])
  }
  params.sort()
  return params
}
async function fixtureRead(filename, name, params) {
  if ((await stat(filename)).size > maximumBytes) throw new CliError('Fixture exceeds output limit', 7)
  const fixture = JSON.parse(await readFile(filename, 'utf8'))
  let items = fixture.resources[name].items.filter(item => name === 'leagues' || item.leagueId === params.get('league'))
  for (const [key, fields] of Object.entries(supported[name].filterFields)) {
    if (!params.has(key) || !fields.length) continue
    const target = params.get(key)
    items = items.filter(item => key === 'query' ? fields.some(field => String(item[field] ?? '').toLowerCase().includes(target.toLowerCase()))
      : key === 'week' ? Number(target) >= item[fields[0]] && Number(target) <= item[fields[1]]
      : fields.some(field => Array.isArray(item[field]) ? item[field].includes(target) : String(item[field]) === target))
  }
  const keys = [params.get('sort') ?? supported[name].order[0], ...supported[name].order.slice(1)]
  const direction = (params.get('direction') ?? supported[name].direction) === 'desc' ? -1 : 1
  items = [...items].sort((a,b) => {
    for (const [index,key] of keys.entries()) {
      if (a[key] === b[key]) continue
      if (a[key] == null) return 1
      if (b[key] == null) return -1
      return (a[key] < b[key] ? -1 : 1) * (index === 0 ? direction : 1)
    }
    return 0
  })
  let offset = 0
  if (params.has('cursor')) {
    try {
      const cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64').toString())
      if (cursor.resource !== name || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('Invalid cursor')
      offset = cursor.offset
    } catch { throw new CliError('Invalid fixture cursor', 2) }
  }
  const limit = Number(params.get('limit') ?? 25)
  return { $schema: `urn:pancake:public:v2:${name}`, version: 2, resource: name,
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
  const url = `${base.href.replace(/\/+$/, '')}/public/v2/${name}?${params}`
  const directory = options['cache-dir'] ?? path.join(homedir(), '.cache', 'pancake')
  const key = createHash('sha256').update(url).digest('hex')
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
  const signal = AbortSignal.timeout(15000)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetcher(url, { headers: cached ? { 'If-None-Match': cached.etag } : {}, redirect: 'error', signal })
      if (![502,503,504].includes(response.status) || attempt === 2) break
      await response.body?.cancel()
    } catch {
      if (attempt === 2 || signal.aborted) throw new CliError('Could not reach the public API', 6)
    }
    await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt))
    if (signal.aborted) throw new CliError('Could not reach the public API', 6)
  }
  if (response.status === 304 && cached) return cached.body
  if (!response.ok) {
    const status = response.status
    await response.body?.cancel()
    throw new CliError(status === 404 ? 'Public resource not found' : status === 429 ? 'Read limit reached' : `Public API returned ${status}`,
      status === 404 ? 4 : status === 429 ? 5 : status === 400 ? 2 : 7)
  }
  let body
  try {
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > maximumBytes) throw new CliError('Response exceeds output limit', 7)
        chunks.push(part.value)
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally { await reader.cancel() }
  } catch (error) {
    if (error instanceof CliError) throw error
    if (signal.aborted || error?.name === 'AbortError' || error instanceof TypeError) throw new CliError('Could not read the public API response', 6)
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
    if (options.version) result = { version: '2.0.0', schemaVersion: 2 }
    else if (options.help || !name || name === 'describe') result = description(target)
    else if (name === 'explain') result = explain(target)
    else if (resources.includes(name)) {
      const params = queryOptions(options, name)
      result = options.fixture ? await fixtureRead(options.fixture, name, params) : await remoteRead(name, options, params, environment, fetcher)
      validate(result, contract.resources[name])
    } else throw new CliError(`Unknown command: ${name}`, 2)
    if (Buffer.byteLength(JSON.stringify(result)) > maximumBytes) throw new CliError('Response exceeds output limit', 7)
    if (json) output.write(`${JSON.stringify(result)}\n`)
    else if (result.items) output.write(result.items.map(item => Object.entries(item).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join('  ')).join('\n') + `\n${result.nextCursor ? `nextCursor=${result.nextCursor}\n` : ''}`)
    else output.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    const code = error instanceof CliError ? error.code : 7
    const message = error instanceof CliError ? error.message : 'Could not read public data'
    errors.write(json ? `${JSON.stringify({ $schema: 'urn:pancake:cli:v2:error', version: 2, error: { code, message } })}\n` : `${message}\n`)
    return code
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await run(process.argv.slice(2))
