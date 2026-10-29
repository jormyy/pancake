import path from 'node:path'
import assert from 'node:assert/strict'
import { withDatabase } from './setup.mjs'
import { startEdge, seedScreens } from './runtime.mjs'
import { certificate, buildWeb } from './build.mjs'
import { captureServer } from './capture.mjs'
import { walk } from './walk.mjs'
import { renderReport } from './report.mjs'
import { labRoot, project, target, json, readJson } from './common.mjs'
import { prepareHeadshots } from './headshots.mjs'
import { captureIdentityConflicts, captureIdentityPairs } from './identity-diagnostics.mjs'
import { failedTwoDayReceipt } from './gates.mjs'
import { checkIdentity } from './identity-check.mjs'

export async function runLab({ limit = Infinity, simulation = true, screens = true } = {}) {
  Object.assign(process.env, { SEASON_SIM_ROOT: labRoot, SEASON_SIM_PROJECT: project, SEASON_SIM_PORT_PREFIX: target.prefix, SEASON_SIM_CLI: 'supabase' })
  const coverage = await readJson(path.join(labRoot, 'evidence/coverage.json')).catch(() => null)
  const gameDates = new Set((await readJson(path.join(labRoot, 'fixtures/games.json')).catch(() => ({ games: [] }))).games.map(game => game.date))
  if (simulation && (!coverage?.complete || coverage.start !== '2025-10-21' || coverage.end !== '2025-10-24' || !gameDates.has('2025-10-21') || !gameDates.has('2025-10-24'))) {
    const { collect } = await import('../season-sim/collect.mjs')
    await collect({ start: '2025-10-21', days: 4, games: 100 })
    const collected = await readJson(path.join(labRoot, 'evidence/coverage.json'))
    if (!collected.complete) throw new Error('The two-day input collection is incomplete')
  }
  const tls = screens ? await certificate() : null
  return withDatabase(async ({ evidence, receipt }) => {
    process.env.SEASON_SIM_SNAPSHOT_ROOT = path.join(labRoot, 'snapshots', receipt.runId)
    if (simulation || process.env.PERF_LAB_IDENTITY_EXPECTED) await checkIdentity(process.env.PERF_LAB_IDENTITY_EXPECTED ?? 'linked', evidence)
    let edge, capture, simulationReceipt = null
    try {
      let receipts = []
      if (screens) {
      edge = await startEdge(evidence)
      const stack = await seedScreens(edge.keys)
      await prepareHeadshots(tls.origin)
      const build = await buildWeb(edge.keys, tls)
      capture = await captureServer({ root: build.root, evidence, ...tls, host: '0.0.0.0' })
      receipts = await walk({ origin: tls.origin, fixture: stack.fixture, stack, evidence, capture, limit })
      await capture.close()
      capture = null
      await edge.close()
      edge = null
      }
      if (simulation) {
        process.env.SEASON_SIM_TWO_DAY = '1'
        try {
          simulationReceipt = await (await import('./two-day.mjs')).runTwoDay()
          const identity = await captureIdentityPairs(evidence)
          assert.ok(identity.passed, 'The nine recorded player identities must each have one owner')
          await json(path.join(evidence, 'simulation-exit.json'), { code: 0 })
        } catch (error) {
          await json(path.join(evidence, 'simulation-exit.json'), { code: 1, error: error.message })
          const checkpoint = await readJson(path.join(evidence, 'replay-checkpoint.json')).catch(() => ({}))
          await json(path.join(evidence, 'two-day.json'), failedTwoDayReceipt(checkpoint, error.message, process.env.PERF_LAB_CAPTURE_PROFILE))
          await captureIdentityConflicts(error, evidence).catch(async diagnostic => json(path.join(evidence, 'identity-conflicts.json'), { error: diagnostic.message }))
          await captureIdentityPairs(evidence).catch(async diagnostic => json(path.join(evidence, 'identity-repair.json'), { error: diagnostic.message }))
          throw error
        }
      }
      const { report } = await renderReport({ evidenceRoot: evidence, receipts, simulation: simulationReceipt, writeDocs: false })
      if (!report.done) process.exitCode = 1
      return report
    } finally { await capture?.close(); await edge?.close() }
  }, { restore: process.env.PERF_LAB_RESTORE !== '0' })
}
