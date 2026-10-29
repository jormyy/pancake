import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { certificate } from './perf-lab/build.mjs'
import { captureServer } from './perf-lab/capture.mjs'
import { labRoot, requireMini } from './perf-lab/common.mjs'

await requireMini()
process.env.PERF_LAB_TLS_SELF_SIGNED = '1'
const tls = await certificate()
await mkdir(path.join(labRoot, 'empty'), { recursive: true })
const proxy = await captureServer({ root: path.join(labRoot, 'empty'), evidence: path.join(labRoot, 'evidence'),
  key: tls.key, cert: tls.cert, port: 62084 })
try {
  while (!await access(path.join(labRoot, 'stop')).then(() => true, () => false)) await delay(1000)
} finally { await proxy.close() }
