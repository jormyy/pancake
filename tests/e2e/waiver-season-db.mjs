import { spawnSync } from 'node:child_process'

const url = new URL(process.env.SUPABASE_DB_URL ?? '')
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '57622') {
  throw new Error('This synthetic waiver recipe requires the isolated database on port 57622')
}
const result = spawnSync('psql', [url.href, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/waiver-season-matrix.sql'], {
  stdio: 'inherit', timeout: 60_000,
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
