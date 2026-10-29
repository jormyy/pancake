import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withDatabase } from './perf-lab/setup.mjs'
import { startEdge } from './perf-lab/runtime.mjs'
import { labRoot, project } from './perf-lab/common.mjs'
import { command } from './perf-lab/process.mjs'
import { captureServer } from './perf-lab/capture.mjs'
import { serveBytes } from './bytes-server.mjs'

assert.equal(project, 'pt4bafablel5')
await withDatabase(async ({ evidence }) => {
  const edge = await startEdge(evidence)
  let proxy, server
  try {
    await command('docker', ['update', '--cpus', '0.5', '--memory', '1g', '--memory-swap', '1g', `supabase_db_${project}`])
    await mkdir(path.join(labRoot, 'empty'), { recursive: true })
    proxy = await captureServer({ root: path.join(labRoot, 'empty'), evidence, port: 62088 })
    server = await serveBytes(labRoot)
    await writeFile(path.join(labRoot, 'ready.json'), JSON.stringify({ ready: true, fixture: 'seed/complete.json' }))
    console.log('Private stack ready.')
    const deadline = Date.now() + 8 * 60 * 60 * 1000
    while (Date.now() < deadline) {
      if (await access(path.join(labRoot, 'stop')).then(() => true, () => false)) return
      await delay(1000)
    }
    throw new Error('Private stack lifetime exceeded')
  } finally {
    await server?.close()
    await proxy?.close()
    await edge.close()
    const ready = path.join(labRoot, 'ready.json')
    if (await readFile(ready, 'utf8').catch(() => null)) await writeFile(ready, JSON.stringify({ ready: false }))
  }
})
