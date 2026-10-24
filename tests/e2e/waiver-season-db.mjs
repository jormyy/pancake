import { spawnSync } from 'node:child_process'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const url = databaseTarget()
const result = spawnSync('psql', [url.href, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/waiver-season-matrix.sql'], {
  stdio: 'inherit', timeout: 60_000,
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
