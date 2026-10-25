import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const target = databaseTarget()
execFileSync('psql', [target.href, '-X', '-v', 'ON_ERROR_STOP=1', '-f', fileURLToPath(new URL('./taxi-acquisitions-db.sql', import.meta.url))], {
  stdio: 'inherit', timeout: 60000,
})
