import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations')
const FUNCTION_SOURCES_DIR = path.join(ROOT, 'supabase/sql/functions/by-name')

/** @param {string} source */
export const dollarQuotedStatement = (source) => {
  const asMatch = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(source)
  const semicolonIndex = source.indexOf(';')
  if (!asMatch || (semicolonIndex !== -1 && semicolonIndex < asMatch.index)) {
    if (semicolonIndex === -1) throw new Error('Could not find SQL statement terminator')
    return source.slice(0, semicolonIndex + 1)
  }

  const delimiter = asMatch[1]
  const openIndex = asMatch.index + asMatch[0].lastIndexOf(delimiter)
  const closeIndex = source.indexOf(delimiter, openIndex + delimiter.length)
  if (closeIndex === -1) throw new Error(`Could not find closing ${delimiter} delimiter`)

  const functionTerminator = source.indexOf(';', closeIndex + delimiter.length)
  if (functionTerminator === -1) throw new Error('Could not find SQL function terminator')
  return source.slice(0, functionTerminator + 1)
}

/** @param {string} source */
const normalizeSql = (source) => source.replace(/\r\n/g, '\n').trim()
/** @param {string} key @param {string} [root] */
export const sourcePathForFunctionKey = (key, root = FUNCTION_SOURCES_DIR) => {
  const signatureStart = key.indexOf('(')
  const qualifiedName = signatureStart === -1 ? key : key.slice(0, signatureStart)
  const dot = qualifiedName.indexOf('.')
  if (dot === -1) throw new Error(`Invalid function key ${key}`)
  const schema = qualifiedName.slice(0, dot)
  const name = qualifiedName.slice(dot + 1)
  const signature = signatureStart === -1 ? '' : key.slice(signatureStart + 1, -1)
  const signatureSuffix = signature
    ? `__${signature.replaceAll(/[^A-Za-z0-9]+/g, '_').replaceAll(/^_|_$/g, '') || 'no_args'}`
    : ''
  return path.join(root, schema, `${name}${signatureSuffix}.sql`)
}

/** @param {string} source */
export const maskSqlNonCode = (source, { dollarQuotes = true } = {}) => {
  const chars = [...source]
  /** @param {number} index */
  const mask = (index) => { if (chars[index] !== '\n') chars[index] = ' ' }
  let index = 0
  while (index < source.length) {
    if (source.startsWith('--', index)) {
      while (index < source.length && source[index] !== '\n') mask(index++)
      continue
    }
    if (source.startsWith('/*', index)) {
      let depth = 0
      while (index < source.length) {
        if (source.startsWith('/*', index)) {
          mask(index++); mask(index++); depth += 1
        } else if (source.startsWith('*/', index)) {
          mask(index++); mask(index++); depth -= 1
          if (depth === 0) break
        } else {
          mask(index++)
        }
      }
      continue
    }
    if (source[index] === "'") {
      mask(index++)
      while (index < source.length) {
        mask(index)
        if (source[index] === "'" && source[index + 1] === "'") {
          index += 2
        } else if (source[index++] === "'") {
          break
        }
      }
      continue
    }
    if (dollarQuotes && source[index] === '$') {
      const delimiter = /^\$[A-Za-z0-9_]*\$/.exec(source.slice(index))?.[0]
      if (delimiter) {
        const end = source.indexOf(delimiter, index + delimiter.length)
        const through = end === -1 ? source.length : end + delimiter.length
        while (index < through) mask(index++)
        continue
      }
    }
    index += 1
  }
  return chars.join('')
}

const IDENTIFIER = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)'
/** @param {string} identifier */
const unquoteIdentifier = (identifier) => identifier.startsWith('"')
  ? identifier.slice(1, -1).replaceAll('""', '"')
  : identifier.toLowerCase()
/** @param {string | undefined} schema @param {string} name */
const functionKey = (schema, name) => `${unquoteIdentifier(schema ?? 'public')}.${unquoteIdentifier(name)}`

const TYPE_LEADS = new Set([
  'bigint', 'bigserial', 'bit', 'boolean', 'box', 'bytea', 'character', 'cidr', 'date',
  'decimal', 'double', 'inet', 'integer', 'interval', 'json', 'jsonb', 'macaddr',
  'money', 'numeric', 'real', 'smallint', 'smallserial', 'text', 'time', 'timestamp',
  'uuid', 'varchar', 'xml', 'anyarray', 'anyelement', 'anyenum', 'anynonarray',
])

/** @param {string} value */
const normalizeIdentityType = (value) => value
  .replace(/\bpg_catalog\./gi, '')
  .replace(/\bint2\b/gi, 'smallint')
  .replace(/\bint4\b|\bint\b/gi, 'integer')
  .replace(/\bint8\b/gi, 'bigint')
  .replace(/\bbool\b/gi, 'boolean')
  .replace(/\bfloat8\b/gi, 'double precision')
  .replace(/\bfloat4\b/gi, 'real')
  .replace(/\btimestamptz\b/gi, 'timestamp with time zone')
  .replace(/\btimetz\b/gi, 'time with time zone')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

/** @param {string} source @param {number} openIndex @param {string} [maskedSource] */
export const functionIdentityArguments = (source, openIndex, maskedSource) => {
  const searchable = maskedSource ?? maskSqlNonCode(source)
  let depth = 0
  let segmentStart = openIndex + 1
  /** @type {string[]} */
  const segments = []
  for (let index = openIndex; index < searchable.length; index += 1) {
    if (searchable[index] === '(') depth += 1
    else if (searchable[index] === ')') {
      depth -= 1
      if (depth === 0) {
        segments.push(source.slice(segmentStart, index))
        break
      }
    } else if (searchable[index] === ',' && depth === 1) {
      segments.push(source.slice(segmentStart, index))
      segmentStart = index + 1
    }
  }

  return segments.flatMap((segment) => {
    const declaration = segment
      .replace(/\s+DEFAULT\s+[\s\S]*$/i, '')
      .replace(/\s*=\s*[\s\S]*$/, '')
      .trim()
    if (!declaration) return []
    const tokens = declaration.split(/\s+/)
    const mode = tokens[0]?.toUpperCase()
    if (mode === 'OUT') return []
    if (mode === 'IN' || mode === 'INOUT' || mode === 'VARIADIC') tokens.shift()
    const first = tokens[0]?.replace(/^"|"$/g, '').toLowerCase() ?? ''
    if (tokens.length > 1 && !TYPE_LEADS.has(first) && !first.includes('.') && !first.endsWith('[]')) {
      tokens.shift()
    }
    return [normalizeIdentityType(tokens.join(' '))]
  })
}

/** @typedef {{ type: 'create', key: string, identityKey: string, definition: string, start: number, end: number }} FunctionCreateEvent */
/** @typedef {{ type: 'drop', key: string, identityKey: string, start: number, end: number }} FunctionDropEvent */
/** @typedef {{ type: 'rename', key: string, identityKey: string, renamedKey: string, renamedIdentityKey: string, start: number, end: number }} FunctionRenameEvent */
/** @typedef {{ type: 'set_search_path', key: string, identityKey: string, searchPath: string, start: number, end: number }} FunctionSearchPathEvent */
/** @typedef {FunctionCreateEvent | FunctionDropEvent | FunctionRenameEvent | FunctionSearchPathEvent} FunctionLifecycleEvent */

/** @param {string} source @returns {(FunctionRenameEvent | FunctionSearchPathEvent)[]} */
const functionAlterEventsInSource = (source) => {
  const searchable = maskSqlNonCode(source, { dollarQuotes: false })
  const pattern = new RegExp(`\\bALTER\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:(${IDENTIFIER})\\s*\\.\\s*)?(${IDENTIFIER})\\s*\\(`, 'gi')
  /** @type {(FunctionRenameEvent | FunctionSearchPathEvent)[]} */
  const events = []
  let match

  while ((match = pattern.exec(searchable)) !== null) {
    let depth = 1
    let closeIndex = pattern.lastIndex
    while (closeIndex < searchable.length && depth > 0) {
      if (searchable[closeIndex] === '(') depth += 1
      else if (searchable[closeIndex] === ')') depth -= 1
      closeIndex += 1
    }
    if (depth !== 0) continue
    const renamePattern = new RegExp(`^\\s*RENAME\\s+TO\\s+(${IDENTIFIER})`, 'i')
    const renameMatch = renamePattern.exec(searchable.slice(closeIndex))
    const key = functionKey(match[1], match[2])
    const identityArguments = functionIdentityArguments(source, pattern.lastIndex - 1, searchable)
    const identityKey = `${key}(${identityArguments.join(',')})`
    if (renameMatch) {
      const schema = key.slice(0, key.indexOf('.'))
      const renamedKey = `${schema}.${unquoteIdentifier(renameMatch[1])}`
      events.push({
        type: 'rename',
        key,
        identityKey,
        renamedKey,
        renamedIdentityKey: `${renamedKey}(${identityArguments.join(',')})`,
        start: match.index,
        end: closeIndex + renameMatch[0].length,
      })
      continue
    }
    const searchPathMatch = /^\s*SET\s+search_path\s*(?:=|TO)\s*([^;]+)/i.exec(searchable.slice(closeIndex))
    if (searchPathMatch) {
      events.push({
        type: 'set_search_path',
        key,
        identityKey,
        searchPath: source.slice(closeIndex + searchPathMatch.index, closeIndex + searchPathMatch[0].length)
          .replace(/^\s*SET\s+search_path\s*(?:=|TO)\s*/i, '')
          .trim(),
        start: match.index,
        end: closeIndex + searchPathMatch[0].length,
      })
    }
  }
  return events
}

/** @param {string} definition @param {string} renamedKey */
const renameFunctionDefinition = (definition, renamedKey) => {
  const pattern = new RegExp(`(CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+)(?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER}`, 'i')
  return definition.replace(pattern, `$1${renamedKey}`)
}

/** @param {string} definition @param {string} searchPath */
const setFunctionSearchPath = (definition, searchPath) => {
  const clause = `SET search_path = ${searchPath}`
  if (/\bSET\s+search_path\s*(?:=|TO)\s*[^\n]+/i.test(definition)) {
    return definition.replace(/\bSET\s+search_path\s*(?:=|TO)\s*[^\n]+/i, clause)
  }
  return definition.replace(/(AS\s+\$[A-Za-z0-9_]*\$)/i, `${clause}\n$1`)
}

const migrationFiles = async () =>
  (await readdir(MIGRATIONS_DIR))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort()

const allMigrations = async () => {
  const files = await migrationFiles()
  const chunks = await Promise.all(
    files.map(async (file) => `\n-- migration:${file}\n${await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')}`),
  )
  return chunks.join('\n')
}

/** @param {string} source */
export const functionDefinitionsInSource = (source) => {
  const searchable = maskSqlNonCode(source)
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:(${IDENTIFIER})\\s*\\.\\s*)?(${IDENTIFIER})\\s*\\(`, 'gi')
  const definitions = new Map()
  let match

  while ((match = pattern.exec(searchable)) !== null) {
    definitions.set(functionKey(match[1], match[2]), dollarQuotedStatement(source.slice(match.index)))
  }

  return definitions
}

/** @param {string} source @returns {FunctionLifecycleEvent[]} */
export const functionLifecycleEventsInSource = (source) => {
  const searchable = maskSqlNonCode(source)
  const pattern = new RegExp(`\\b(?:(CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION)\\s+(?:(${IDENTIFIER})\\s*\\.\\s*)?(${IDENTIFIER})\\s*\\(|(DROP\\s+FUNCTION(?:\\s+IF\\s+EXISTS)?)\\s+(?:(${IDENTIFIER})\\s*\\.\\s*)?(${IDENTIFIER})\\s*\\()`, 'gi')
  /** @type {(FunctionCreateEvent | FunctionDropEvent)[]} */
  const events = []
  let match

  while ((match = pattern.exec(searchable)) !== null) {
    if (match[1]) {
      const definition = dollarQuotedStatement(source.slice(match.index))
      const key = functionKey(match[2], match[3])
      const identityArguments = functionIdentityArguments(source, pattern.lastIndex - 1, searchable)
      events.push({
        type: 'create',
        key,
        identityKey: `${key}(${identityArguments.join(',')})`,
        definition,
        start: match.index,
        end: match.index + definition.length,
      })
    } else {
      const key = functionKey(match[5], match[6])
      const identityArguments = functionIdentityArguments(source, pattern.lastIndex - 1, searchable)
      events.push({
        type: 'drop',
        key,
        identityKey: `${key}(${identityArguments.join(',')})`,
        start: match.index,
        end: pattern.lastIndex,
      })
    }
  }

  return [...events, ...functionAlterEventsInSource(source)].sort((left, right) => left.start - right.start)
}

/** @param {string} migrations @returns {Map<string, string>} */
export const latestFunctionDefinitionsInSource = (migrations) => {
  const definitions = new Map()
  for (const event of functionLifecycleEventsInSource(migrations)) {
    if (event.type === 'create') definitions.set(event.identityKey, { key: event.key, definition: event.definition })
    else if (event.type === 'drop') definitions.delete(event.identityKey)
    else if (event.type === 'rename') {
      const entry = definitions.get(event.identityKey)
      if (!entry) continue
      definitions.delete(event.identityKey)
      definitions.set(event.renamedIdentityKey, {
        key: event.renamedKey,
        definition: renameFunctionDefinition(entry.definition, event.renamedKey),
      })
    } else {
      const entry = definitions.get(event.identityKey)
      if (!entry) continue
      definitions.set(event.identityKey, {
        ...entry,
        definition: setFunctionSearchPath(entry.definition, event.searchPath),
      })
    }
  }
  const definitionCounts = new Map()
  for (const entry of definitions.values()) {
    definitionCounts.set(entry.key, (definitionCounts.get(entry.key) ?? 0) + 1)
  }
  const output = new Map()
  for (const [identityKey, entry] of definitions) {
    output.set(definitionCounts.get(entry.key) === 1 ? entry.key : identityKey, entry.definition)
  }
  return new Map([...output.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

export const latestFunctionDefinitions = async () => latestFunctionDefinitionsInSource(await allMigrations())

/** @param {string} schema @param {string} name */
export const latestFunctionDefinition = async (schema, name) => {
  const migrations = await allMigrations()
  const key = `${schema}.${name}`
  let wasDefined = false
  let wasDroppedAfterDefinition = false
  /** @type {string | null} */
  let definition = null
  /** @type {string | null} */
  let activeIdentityKey = null

  for (const event of functionLifecycleEventsInSource(migrations)) {
    if (event.key !== key) continue
    if (event.type === 'create') {
      wasDefined = true
      wasDroppedAfterDefinition = false
      definition = event.definition ?? null
      activeIdentityKey = event.identityKey
      continue
    }
    if (activeIdentityKey === event.identityKey) {
      if (wasDefined) wasDroppedAfterDefinition = true
      definition = null
      activeIdentityKey = null
    }
  }

  if (!definition) {
    throw new Error(wasDroppedAfterDefinition ? `${schema}.${name} is dropped after its latest definition` : `No migration defines ${schema}.${name}`)
  }
  return definition
}

export const writeFunctionSources = async () => {
  const definitions = await latestFunctionDefinitions()
  const parent = path.dirname(FUNCTION_SOURCES_DIR)
  const generatedDir = await mkdtemp(path.join(parent, '.by-name-generated-'))
  const backupDir = path.join(parent, '.by-name-backup')

  try {
    await Promise.all([...definitions].map(async ([key, definition]) => {
      const target = sourcePathForFunctionKey(key, generatedDir)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, [
        `-- Canonical SQL source for ${key}.`,
        '-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.',
        '-- npm run check:db-function-sources verifies every latest migration function has exact source parity.',
        '',
        normalizeSql(definition),
        '',
      ].join('\n'), 'utf8')
    }))

    await rm(backupDir, { recursive: true, force: true })
    await rename(FUNCTION_SOURCES_DIR, backupDir)
    try {
      await rename(generatedDir, FUNCTION_SOURCES_DIR)
    } catch (error) {
      await rename(backupDir, FUNCTION_SOURCES_DIR)
      throw error
    }
    await rm(backupDir, { recursive: true, force: true })
  } finally {
    await rm(generatedDir, { recursive: true, force: true })
  }
}

/** @param {string} key @param {string} migrationDefinition @param {string} source */
export const checkFunctionSourceText = (key, migrationDefinition, source) => {
  const events = functionLifecycleEventsInSource(source).filter((event) => event.type === 'create')
  const expectedEvent = key.includes('(')
    ? events.find((event) => event.identityKey === key)
    : events.length === 1 && events[0].key === key ? events[0] : null
  if (!expectedEvent?.definition) return [`source is missing ${key}`]
  const failures = events
    .filter((event) => event !== expectedEvent)
    .map((event) => `source contains unmanaged function ${event.identityKey}`)
  if (normalizeSql(expectedEvent.definition) !== normalizeSql(migrationDefinition)) {
    failures.push(`source does not match latest migration definition for ${key}`)
  }
  return failures
}

/** @param {string} key @param {string} migrationDefinition */
export const checkFunctionSource = async (key, migrationDefinition) => {
  const sourcePath = sourcePathForFunctionKey(key)
  const source = await readFile(sourcePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (source === null) return [`${path.relative(ROOT, sourcePath)} is missing`]
  return checkFunctionSourceText(key, migrationDefinition, source)
    .map((failure) => `${path.relative(ROOT, sourcePath)} ${failure}`)
}

/** @param {string} dir @returns {Promise<string[]>} */
const sqlFilesUnder = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return sqlFilesUnder(fullPath)
    return entry.isFile() && entry.name.endsWith('.sql') ? [fullPath] : []
  }))
  return nested.flat()
}

export const checkFunctionSources = async () => {
  const latestDefinitions = await latestFunctionDefinitions()
  const checks = await Promise.all([...latestDefinitions.entries()].map(([key, definition]) =>
    checkFunctionSource(key, definition)))
  const failures = checks.flat()

  const expectedKeys = new Set(latestDefinitions.keys())
  for (const file of await sqlFilesUnder(FUNCTION_SOURCES_DIR)) {
    const source = await readFile(file, 'utf8')
    for (const event of functionLifecycleEventsInSource(source)) {
      if (event.type !== 'create') continue
      if (!expectedKeys.has(event.identityKey) && !expectedKeys.has(event.key)) {
        failures.push(`${path.relative(ROOT, file)} contains ${event.identityKey}, which is not defined by the latest migrations`)
      }
    }
  }

  return failures
}

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`

const functionFingerprintSql = (alias) => `jsonb_build_object(
  'language', ${alias}.language,
  'body', ${alias}.prosrc,
  'binary', ${alias}.probin,
  'kind', ${alias}.prokind,
  'security_definer', ${alias}.prosecdef,
  'leakproof', ${alias}.proleakproof,
  'strict', ${alias}.proisstrict,
  'returns_set', ${alias}.proretset,
  'volatility', ${alias}.provolatile,
  'parallel', ${alias}.proparallel,
  'return_type', ${alias}.return_type,
  'all_arg_types', ${alias}.all_arg_types,
  'arg_modes', ${alias}.proargmodes,
  'arg_names', ${alias}.proargnames,
  'defaults', ${alias}.defaults,
  'config', ${alias}.proconfig,
  'cost', ${alias}.procost,
  'rows', ${alias}.prorows
)`

/** @param {string} definition @param {string} scratchName */
const scratchFunctionDefinition = (definition, scratchName) => {
  const pattern = new RegExp(`(CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+)(?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER}`, 'i')
  return definition.replace(pattern, `$1db_source_check.${scratchName}`)
}

export const checkFunctionCatalog = async () => {
  const files = await sqlFilesUnder(FUNCTION_SOURCES_DIR)
  const sources = []
  for (const [index, file] of files.sort().entries()) {
    const source = await readFile(file, 'utf8')
    const definitions = functionLifecycleEventsInSource(source).filter((event) => event.type === 'create')
    if (definitions.length !== 1) continue
    const event = definitions[0]
    const dot = event.key.indexOf('.')
    sources.push({
      scratchName: `function_${index}`,
      schema: event.key.slice(0, dot),
      name: event.key.slice(dot + 1),
      identityArguments: event.identityKey.slice(event.identityKey.indexOf('(') + 1, -1),
      definition: scratchFunctionDefinition(event.definition, `function_${index}`),
    })
  }

  const values = sources.map((source) => `(
    ${sqlLiteral(source.scratchName)}, ${sqlLiteral(source.schema)},
    ${sqlLiteral(source.name)}, ${sqlLiteral(source.identityArguments)}
  )`).join(',\n')
  const definitions = sources.map((source) => source.definition).join('\n\n')
  const catalogCte = (schemaPredicate) => `SELECT
      namespace.nspname AS schema_name,
      procedure.proname,
      replace(pg_catalog.oidvectortypes(procedure.proargtypes), ', ', ',') AS identity_arguments,
      language.lanname AS language,
      procedure.prosrc,
      procedure.probin,
      procedure.prokind,
      procedure.prosecdef,
      procedure.proleakproof,
      procedure.proisstrict,
      procedure.proretset,
      procedure.provolatile,
      procedure.proparallel,
      procedure.prorettype::regtype::text AS return_type,
      procedure.proallargtypes::regtype[]::text AS all_arg_types,
      procedure.proargmodes,
      procedure.proargnames,
      pg_get_expr(procedure.proargdefaults, 0) AS defaults,
      procedure.proconfig,
      procedure.procost,
      procedure.prorows
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_language AS language ON language.oid = procedure.prolang
    WHERE procedure.prokind = 'f' AND ${schemaPredicate}`
  const sql = `
BEGIN;
SET LOCAL check_function_bodies = off;
CREATE SCHEMA db_source_check;
${definitions}
WITH expected(scratch_name, schema_name, function_name, identity_arguments) AS (VALUES ${values}),
live AS (${catalogCte("namespace.nspname IN ('public', 'private', 'analytics')")}),
scratch AS (${catalogCte("namespace.nspname = 'db_source_check'")}),
comparison AS (
  SELECT expected.schema_name || '.' || expected.function_name || '(' || expected.identity_arguments || ')' AS function_key,
    ${functionFingerprintSql('live')} AS live_fingerprint,
    ${functionFingerprintSql('scratch')} AS source_fingerprint
  FROM expected
  LEFT JOIN live ON live.schema_name = expected.schema_name
    AND live.proname = expected.function_name
    AND live.identity_arguments = expected.identity_arguments
  LEFT JOIN scratch ON scratch.proname = expected.scratch_name
), extras AS (
  SELECT live.schema_name || '.' || live.proname || '(' || live.identity_arguments || ')' AS function_key
  FROM live
  LEFT JOIN expected ON expected.schema_name = live.schema_name
    AND expected.function_name = live.proname
    AND expected.identity_arguments = live.identity_arguments
  WHERE expected.function_name IS NULL
)
SELECT COALESCE(jsonb_agg(issue ORDER BY issue->>'functionKey'), '[]'::jsonb)
FROM (
  SELECT jsonb_build_object(
    'functionKey', comparison.function_key,
    'problem', CASE WHEN comparison.live_fingerprint IS NULL THEN 'missing from live catalog' ELSE 'definition differs from canonical source' END
  ) AS issue
  FROM comparison
  WHERE comparison.live_fingerprint IS NULL OR comparison.live_fingerprint <> comparison.source_fingerprint
  UNION ALL
  SELECT jsonb_build_object('functionKey', extras.function_key, 'problem', 'missing canonical source') FROM extras
) AS issues;
ROLLBACK;
`
  const databaseUrl = process.env.SUPABASE_DB_URL
  if (!databaseUrl) throw new Error('SUPABASE_DB_URL is required for --check-catalog')
  const output = execFileSync('psql', [databaseUrl, '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: sql,
  })
  return JSON.parse(output.trim().split('\n').find((line) => line.startsWith('[')) ?? '[]')
}

const runCli = async () => {
  const command = process.argv[2] ?? '--check'
  if (command === '--write') {
    await writeFunctionSources()
    return
  }
  if (command === '--check-catalog') {
    const failures = await checkFunctionCatalog()
    if (failures.length > 0) {
      for (const failure of failures) console.error(`- ${failure.functionKey}: ${failure.problem}`)
      process.exitCode = 1
    }
    return
  }
  if (command !== '--check') {
    throw new Error(`Unknown command ${command}. Use --check, --check-catalog, or --write.`)
  }

  const failures = await checkFunctionSources()
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
