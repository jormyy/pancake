import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { querySupabaseDb } from './env.mjs'

const migrationVersion = (filename) => filename.split('_', 1)[0]

const readRepositorySchemaVersion = async (root = process.cwd()) => {
  const migrations = (await readdir(path.join(root, 'supabase/migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const head = migrations.at(-1)
  if (!head) throw new Error('No repository migrations found')
  return migrationVersion(head)
}

export const readAppliedSchemaVersion = (queryDb = querySupabaseDb) => {
  const rows = queryDb(
    'local',
    'schema migration head',
    'select version from supabase_migrations.schema_migrations order by version desc limit 1',
  )
  const version = rows[0]?.version
  if (typeof version !== 'string' || !/^\d+$/.test(version)) {
    throw new Error('Could not determine the applied schema migration head')
  }
  return version
}

export const resolveSchemaProvenance = async ({ root = process.cwd(), queryDb = querySupabaseDb } = {}) => ({
  schemaVersion: readAppliedSchemaVersion(queryDb),
  repositorySchemaVersion: await readRepositorySchemaVersion(root),
})
