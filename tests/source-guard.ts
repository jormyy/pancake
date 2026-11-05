import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { functionLifecycleEventsInSource, dollarQuotedStatement } from '../scripts/check-db-function-sources.mjs'

export const ROOT = path.resolve(__dirname, '..')

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')
export const readFunctionSource = (functionName: string, schema = 'public'): string =>
    read(`supabase/sql/functions/by-name/${schema}/${functionName}.sql`)
const migrationFiles = readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort()

const allMigrations = (): string =>
    migrationFiles
        .map((file) => `\n-- migration:${file}\n${read(`supabase/migrations/${file}`)}`)
        .join('\n')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const objectNamePattern = (name: string, schema: string): string =>
    schema === 'public'
        ? `(?:${escapeRegExp(schema)}\\.)?${escapeRegExp(name)}`
        : `${escapeRegExp(schema)}\\.${escapeRegExp(name)}`
const identifierPattern = (identifier: string): string =>
    `(?:"${escapeRegExp(identifier.replaceAll('"', '""'))}"|${escapeRegExp(identifier)})`

export const latestFunctionDefinition = (functionName: string, schema = 'public'): string => {
    const key = `${schema}.${functionName}`
    let definition: string | null = null
    let wasDefined = false
    for (const event of functionLifecycleEventsInSource(allMigrations())) {
        if (event.key !== key) continue
        if (event.type === 'create' && 'definition' in event) {
            if (!event.definition) throw new Error(`Missing CREATE definition for ${key}`)
            definition = event.definition
            wasDefined = true
        } else {
            definition = null
        }
    }
    if (definition) return definition
    if (wasDefined) throw new Error(`${key} is dropped after its latest definition`)
    throw new Error(`No migration defines ${key}`)
}

export const latestPolicyDefinition = (policyName: string, tableName: string, schema = 'public'): string => {
    const migrations = allMigrations()
    const policy = identifierPattern(policyName)
    const table = objectNamePattern(tableName, schema)
    const createPattern = new RegExp(`CREATE\\s+POLICY\\s+${policy}\\s+ON\\s+${table}\\b`, 'gi')
    let createMatch: RegExpExecArray | null
    let latestCreateIndex = -1

    while ((createMatch = createPattern.exec(migrations)) !== null) {
        latestCreateIndex = createMatch.index
    }

    if (latestCreateIndex === -1) {
        throw new Error(`No migration defines policy ${policyName} on ${schema}.${tableName}`)
    }

    const definition = dollarQuotedStatement(migrations.slice(latestCreateIndex))
    const laterSql = migrations.slice(latestCreateIndex + definition.length)
    const dropPattern = new RegExp(`DROP\\s+POLICY(?:\\s+IF\\s+EXISTS)?\\s+${policy}\\s+ON\\s+${table}\\b`, 'i')

    if (dropPattern.test(laterSql)) {
        throw new Error(`Policy ${policyName} on ${schema}.${tableName} is dropped after its latest definition`)
    }

    return definition
}

export const functionPrivilegeStatements = (functionName: string, schema = 'public'): string[] => {
    const qualifiedName = objectNamePattern(functionName, schema)
    const pattern = new RegExp(
        `(?:REVOKE|GRANT)\\s+[^;]*\\bON\\s+FUNCTION\\s+${qualifiedName}\\s*\\([^)]*\\)[^;]*;`,
        'gi',
    )
    return allMigrations().match(pattern) ?? []
}

export const tablePrivilegeStatements = (tableName: string, schema = 'public'): string[] => {
    const qualifiedName = objectNamePattern(tableName, schema)
    const pattern = new RegExp(`(?:REVOKE|GRANT)\\s+[^;]*\\bON\\s+${qualifiedName}\\b[^;]*;`, 'gi')
    return allMigrations().match(pattern) ?? []
}
