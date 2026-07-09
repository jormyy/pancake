import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations')
const FUNCTION_SOURCES_DIR = path.join(ROOT, 'supabase/sql/functions/by-name')

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const objectNamePattern = (name, schema) => {
  const escapedName = escapeRegExp(name)
  if (schema === 'public') return `(?:${escapeRegExp(schema)}\\.)?${escapedName}`
  return `${escapeRegExp(schema)}\\.${escapedName}`
}

const dollarQuotedStatement = (source) => {
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

const normalizeSql = (source) => source.replace(/\r\n/g, '\n').trim()
const functionKey = ([schema, name]) => `${schema}.${name}`
const sourcePathForFunction = (schema, name) => path.join(FUNCTION_SOURCES_DIR, schema, `${name}.sql`)

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

export const functionDefinitionsInSource = (source) => {
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(public|private|analytics)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi
  const definitions = new Map()
  let match

  while ((match = pattern.exec(source)) !== null) {
    const schema = match[1] ?? 'public'
    const name = match[2]
    definitions.set(`${schema}.${name}`, dollarQuotedStatement(source.slice(match.index)))
  }

  return definitions
}

export const latestFunctionDefinitions = async () => {
  const migrations = await allMigrations()
  const definitions = functionDefinitionsInSource(migrations)
  return new Map([...definitions.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

export const latestFunctionDefinition = async (schema, name) => {
  const migrations = await allMigrations()
  const qualifiedName = objectNamePattern(name, schema)
  const createPattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${qualifiedName}\\s*\\(`, 'gi')
  let createMatch
  let latestCreateIndex = -1

  while ((createMatch = createPattern.exec(migrations)) !== null) {
    latestCreateIndex = createMatch.index
  }

  if (latestCreateIndex === -1) {
    throw new Error(`No migration defines ${schema}.${name}`)
  }

  return dollarQuotedStatement(migrations.slice(latestCreateIndex))
}

export const writeFunctionSources = async () => {
  const definitions = await latestFunctionDefinitions()
  await rm(FUNCTION_SOURCES_DIR, { recursive: true, force: true })

  for (const [key, definition] of definitions) {
    const [schema, name] = key.split('.')
    const target = sourcePathForFunction(schema, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, [
      `-- Canonical SQL source for ${key}.`,
      '-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.',
      '-- npm run check:db-function-sources verifies every latest migration function has exact source parity.',
      '',
      normalizeSql(definition),
      '',
    ].join('\n'), 'utf8')
  }
}

export const checkFunctionSource = async (key, migrationDefinition) => {
  const [schema, name] = key.split('.')
  const sourcePath = sourcePathForFunction(schema, name)
  const source = await readFile(sourcePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (source === null) return [`${path.relative(ROOT, sourcePath)} is missing`]

  const sourceDefinitions = functionDefinitionsInSource(source)
  const sourceDefinition = sourceDefinitions.get(key)
  if (!sourceDefinition) return [`${path.relative(ROOT, sourcePath)} is missing ${key}`]

  const extraKeys = [...sourceDefinitions.keys()].filter((sourceKey) => sourceKey !== key)
  const failures = extraKeys.map((sourceKey) =>
    `${path.relative(ROOT, sourcePath)} contains unmanaged function ${sourceKey}`)

  if (normalizeSql(sourceDefinition) !== normalizeSql(migrationDefinition)) {
    failures.push(`${path.relative(ROOT, sourcePath)} does not match latest migration definition for ${key}`)
  }

  return failures
}

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
    for (const key of functionDefinitionsInSource(source).keys()) {
      if (!expectedKeys.has(key)) {
        failures.push(`${path.relative(ROOT, file)} contains ${key}, which is not defined by the latest migrations`)
      }
    }
  }

  return failures
}

const runCli = async () => {
  const command = process.argv[2] ?? '--check'
  if (command === '--write') {
    await writeFunctionSources()
    return
  }
  if (command !== '--check') {
    throw new Error(`Unknown command ${command}. Use --check or --write.`)
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
