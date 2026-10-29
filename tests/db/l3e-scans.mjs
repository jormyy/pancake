import assert from 'node:assert/strict'
import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'
import { labRoot, project, target, json } from '../../scripts/perf-lab/common.mjs'
import { sql } from '../../scripts/perf-lab/database.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'

assert.equal(project, 'pt4bafablesq')
assert.equal(target.prefix, '632')
assert.equal(target.lane, 'fable-l3e')
Object.assign(process.env, { SEASON_SIM_ROOT: labRoot, SEASON_SIM_PROJECT: project, SEASON_SIM_PORT_PREFIX: target.prefix, SEASON_SIM_CLI: 'supabase', SEASON_SIM_TWO_DAY: '1' })
await rm(path.join(labRoot, 'ready.json'), { force: true })
await rm(path.join(labRoot, 'finish'), { force: true })
await withDatabase(async () => {
  await command('docker', ['update', '--cpus=0.5', '--memory=1g', '--memory-swap=1g', `supabase_db_${project}`])
  await sql('ANALYZE;')
  await sql("ALTER SYSTEM SET auto_explain.log_format='json'; ALTER SYSTEM SET auto_explain.log_min_duration='0'; ALTER SYSTEM SET auto_explain.sample_rate='1'; SELECT pg_reload_conf();")
  await json(path.join(labRoot, 'ready.json'), { project, prefix: target.prefix, cpus: 0.5, at: new Date().toISOString() })
  for (;;) {
    try { await access(path.join(labRoot, 'finish')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(1000)
  }
})
