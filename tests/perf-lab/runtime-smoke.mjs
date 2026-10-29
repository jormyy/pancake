import { withDatabase } from '../../scripts/perf-lab/setup.mjs'
import { startEdge, seedScreens } from '../../scripts/perf-lab/runtime.mjs'
import { certificate, buildWeb } from '../../scripts/perf-lab/build.mjs'
import { captureServer } from '../../scripts/perf-lab/capture.mjs'
import { walk } from '../../scripts/perf-lab/walk.mjs'
import { json, requireMini } from '../../scripts/perf-lab/common.mjs'
import path from 'node:path'
import { renderReport } from '../../scripts/perf-lab/report.mjs'

await requireMini()
await withDatabase(async ({ evidence }) => {
  let edge, capture
  try {
    console.log('Starting the local Edge runtime.')
    edge = await startEdge(evidence)
    console.log('Preparing the screen fixtures.')
    const stack = await seedScreens(edge.keys)
    console.log('Building the local HTTPS export.')
    const tls = await certificate()
    const build = await buildWeb(edge.keys, tls)
    capture = await captureServer({ root: build.root, evidence, ...tls, host: '0.0.0.0' })
    console.log('Walking the first screen states.')
    const receipts = await walk({ origin: tls.origin, fixture: stack.fixture, evidence, capture, limit: 3 })
    await renderReport({ evidenceRoot: evidence, receipts, writeDocs: false })
    await json(path.join(evidence, 'runtime-smoke.json'), { passed: receipts.length === 3 && receipts.every(row => row.webkit.passed), observed: receipts.length, failed: receipts.filter(row => !row.webkit.passed).length })
  } finally { await capture?.close(); await edge?.close() }
}, { restore: process.env.PERF_LAB_RESTORE === '1' })
