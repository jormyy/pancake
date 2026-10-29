import assert from 'node:assert/strict'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'
import { project, ports, requireMini } from '../../scripts/perf-lab/common.mjs'
import { localKeys } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'

await requireMini()
assert.equal(project, 'pt4bafablesq')
const regenerate = async () => {
  const keys = await localKeys()
  await command('node', ['scripts/regenerate-release-history-attestations.mjs'], {
    env: { ...process.env, SUPABASE_DB_URL: keys.DB_URL, PANCAKE_TEST_DB_PORT: String(ports.db) },
  })
  console.log('Private schema attestations regenerated.')
}
if (process.argv.includes('--existing')) await regenerate()
else await withDatabase(regenerate, { restore: false })
