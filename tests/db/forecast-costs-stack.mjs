import assert from 'node:assert/strict'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { labRoot, ports, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'

await requireMini()
assert.equal(project, 'pt4bafablefo')
assert.equal(ports.db, 62922)
await mkdir(path.join(labRoot, 'bin'), { recursive: true })
await writeFile(path.join(labRoot, 'bin/supabase'), '#!/bin/sh\nexec "$HOME/pancake-local/tools/supabase" --network-id pt4bafablefo "$@"\n', { mode: 0o700 })
const ready = path.join(labRoot, 'forecast-ready')
const stop = path.join(labRoot, 'forecast-stop')
await rm(ready, { force: true })
await rm(stop, { force: true })
await withDatabase(async () => {
  await command('docker', ['update', '--cpus=0.25', '--memory=1g', '--memory-swap=1g', `supabase_db_${project}`])
  await writeFile(ready, `${new Date().toISOString()}\n`)
  console.log('Forecast database ready: quarter CPU, 1 GiB, external HTTP fenced, cron disabled.')
  while (!(await access(stop).then(() => true, () => false))) await delay(1000)
})
await rm(ready, { force: true })
await rm(stop, { force: true })
