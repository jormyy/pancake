import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'

await requireMini()
assert.equal(project, 'pt4bafablesq')
const virtual = await sql("SELECT to_regprocedure('pg_catalog.season_sim_native_now()') IS NOT NULL")
if (virtual === 't') {
  const restore = await readFile('scripts/season-sim/restore-clock.sql', 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
}
await command('supabase', ['migration', 'repair', '--local', '--status', 'reverted', '20261214002100'])
await sql('DROP INDEX IF EXISTS private.work_items_retention; DROP INDEX IF EXISTS private.work_items_dashboard; DROP INDEX IF EXISTS public.idx_players_identity_name_lookup;')
await command('supabase', ['migration', 'up', '--local', '--include-all'], { timeout: 240000 })
await command('node', ['tests/db/l3e-attest.mjs', '--existing'])
const { localKeys } = await import('../../scripts/perf-lab/database.mjs')
const keys = await localKeys()
await command('node', ['scripts/check-db-function-sources.mjs', '--write-catalog-manifest'], { env: { ...process.env, SUPABASE_DB_URL: keys.DB_URL } })
console.log('L3e migration applied and attested on the private bench.')
