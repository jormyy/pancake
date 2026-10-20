import { execFileSync } from 'node:child_process'
import { readFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { miniRoot } from './common.mjs'
import { localKeys, sql } from './local-stack.mjs'
import { setClock } from './clock.mjs'
import { clockTime } from './virtual-clock.mjs'

const keys = localKeys()
process.env.SUPABASE_URL = keys.API_URL
process.env.SUPABASE_DB_URL = keys.DB_URL
const env = { ...process.env, PATH: `${path.join(miniRoot, 'tools')}:${process.env.PATH}`, PANCAKE_SUPABASE_SECRET_KEY: keys.SECRET_KEY ?? keys.SERVICE_ROLE_KEY, PANCAKE_EDGE_INTERNAL_TOKEN: 'synthetic-local-verification-token' }
await symlink(path.join(miniRoot, 'repo/scripts/season-sim/psql.mjs'), path.join(miniRoot, 'tools/psql')).catch(error => { if (error.code !== 'EEXIST') throw error })
if (process.argv.includes('--clock-roundtrip')) {
  const saved = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
  const query = "SELECT md5(string_agg(p.oid::text || p.prosrc,'' ORDER BY p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prokind='f'"
  const before = await sql(query)
  const restore = await readFile(new URL('./restore-clock.sql', import.meta.url), 'utf8')
  await sql(restore.slice(restore.indexOf('BEGIN;')))
  const native = Number(await sql('SELECT extract(epoch FROM now())*1000'))
  if (Math.abs(native - Date.now()) > 2000) throw new Error('Native clock restoration failed')
  if (await sql(query) !== before) throw new Error('Clock restoration changed application functions')
  await setClock({ at: new Date(clockTime(saved, Date.now())).toISOString(), rate: 0, install: true })
  if (await sql(query) !== before) throw new Error('Clock installation changed application functions')
  console.log('native clock restore/reinstall preserves current backend definitions: PASS')
} else if (process.argv.includes('--live-recipe')) {
  const saved = JSON.parse(await readFile(path.join(miniRoot, 'state/clock.json'), 'utf8'))
  await setClock({ at: new Date().toISOString(), rate: 1 })
  try {
    execFileSync('deno', ['run', '--allow-env', '--allow-read', '--allow-net=127.0.0.1,localhost', '--allow-run=psql,deno', 'supabase/tests/db/live-ingestion-clock.ts'], { env, stdio: 'inherit' })
  } finally { await setClock({ at: new Date(clockTime(saved, Date.now())).toISOString(), rate: 0 }) }
} else {
  execFileSync('node', ['scripts/check-db-function-sources.mjs', '--check-catalog'], { env, stdio: 'inherit' })
  for (const file of ['tests/db/live-snapshot-order.sql', 'tests/db/game-stats-completion.sql', 'tests/db/pre-tipoff-lineups.sql']) console.log(await sql('SET ROLE postgres;' + await readFile(file, 'utf8')))
}
