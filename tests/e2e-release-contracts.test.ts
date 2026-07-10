import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertFullSweepRoutes, REQUIRED_FULL_SWEEP_LABELS } from './e2e/browser-smoke.mjs'
import { productionBrowserFailures } from './e2e/production-web-hydration.mjs'
import { writeRegisteredScenarioReport } from './e2e/browser-scenario-registry.mjs'
import { browserCiContext } from './e2e/browser-ci-scenario.mjs'
import { validateManifest, validateRetainedSeasonReports, validateWorkflowReportKeys } from './e2e/performance-budgets.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('release E2E contracts', () => {
  it('keeps the configured mid-life migration probe at repository head', async () => {
    const configured = JSON.parse(await readFile(path.join(process.cwd(), 'tests/e2e/midlife-migration.json'), 'utf8'))
    const migrations = (await readdir(path.join(process.cwd(), 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort()
    expect(configured.filename).toBe(migrations.at(-1))
  })

  it('runs the full measured smoke sweep and enforces its workflow budgets in PR CI', async () => {
    expect(browserCiContext('smoke').args.browserFullSweep).toBe(true)
    expect(browserCiContext('performance').args.browserFullSweep).toBe(false)
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/test.yml'), 'utf8')
    expect(workflow).toContain("if: matrix.scenario == 'smoke'")
    expect(workflow).toContain('npm run perf:budget -- --require-workflow-reports')
  })

  it('requires every declared global performance budget', () => {
    const failures = validateManifest({ version: 1, workflows: [], globalBudgets: {} })
    for (const key of ['longTaskMs', 'maxInitialWebJsKb', 'maxRouteWebJsKb', 'maxDbQueryMs']) {
      expect(failures).toContain(`globalBudgets.${key} must be a positive number`)
    }
  })

  it('fails responsive scenarios when viewport setup fails', async () => {
    const files = ['browser-gameplay.mjs', 'browser-perf-smoke.mjs', 'browser-playoff-gameplay.mjs', 'browser-rookie-draft-gameplay.mjs', 'browser-trade-acceptance-scenarios.mjs', 'browser-trade-proposal-scenarios.mjs', 'browser-trade-terminal-scenarios.mjs']
    for (const file of files) {
      const source = await readFile(path.join(process.cwd(), 'tests/e2e', file), 'utf8')
      expect(source, file).not.toMatch(/\['set', 'viewport'[^\n]+\.catch\(/)
    }
  })

  it('retains seed and stack diagnostics in browser and release workflows', async () => {
    for (const file of ['.github/workflows/test.yml', '.github/workflows/release-soak.yml']) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('tests/e2e-seed-report.md')
      expect(source, file).toContain('tests/artifacts/stack/web.log')
      expect(source, file).toContain('tests/artifacts/stack/edge.log')
    }
  })

  it('runs performance mutations only inside an owned disposable league', async () => {
    const perfSource = await readFile(path.join(process.cwd(), 'tests/e2e/browser-perf-smoke.mjs'), 'utf8')
    const registrySource = await readFile(path.join(process.cwd(), 'tests/e2e/browser-scenario-registry.mjs'), 'utf8')
    expect(perfSource).toContain('createDisposableLeagueFromSeedUsers({')
    expect(perfSource).toContain('resourceOwner,')
    expect(perfSource).not.toContain('stale auction draft cleanup')
    expect(registrySource).toContain('(resourceOwner) => scenario.run({ ...context, resourceOwner })')
  })

  it('builds measured browser evidence with production Metro optimizations', async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'tests/e2e/performance-budgets.json'), 'utf8'))
    expect(manifest.globalBudgets.maxInitialWebJsKb).toBe(700)

    for (const file of ['.github/workflows/test.yml', '.github/workflows/release-soak.yml']) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1')
      expect(source, file).not.toContain('EXPO_UNSTABLE_TREE_SHAKING=1')
      expect(source, file).not.toContain('EXPO_USE_METRO_REQUIRE=1')
      expect(source, file).toContain('npm run e2e:web-hydration')
    }

    const staticServer = await readFile(path.join(process.cwd(), 'tests/e2e/static-web-server.mjs'), 'utf8')
    expect(staticServer).toContain("'content-encoding': encoding")
    expect(staticServer).toContain('createBrotliCompress()')
  })

  it('uses the public sign-in path for the production auth guard', async () => {
    const rootLayout = await readFile(path.join(process.cwd(), 'app/_layout.tsx'), 'utf8')
    expect(rootLayout).toContain("router.replace('/sign-in')")
    expect(rootLayout).not.toContain("router.replace('/(auth)/sign-in')")
  })

  it('fails production hydration on browser, console, and React hydration errors', () => {
    expect(productionBrowserFailures({ consoleOutput: 'console clean', errorOutput: '' })).toEqual([])
    expect(productionBrowserFailures({ consoleOutput: '[error] Hydration failed because the server rendered HTML did not match', errorOutput: '' }))
      .toEqual([expect.stringContaining('console errors')])
    expect(productionBrowserFailures({ consoleOutput: '', errorOutput: 'TypeError: render failed' }))
      .toEqual([expect.stringContaining('browser errors')])
    expect(productionBrowserFailures({ consoleOutput: '[warn] benign warning', errorOutput: '' })).toEqual([])
  })

  it('gates every browser evidence surface on console and browser errors', async () => {
    for (const file of ['browser-smoke.mjs', 'browser-perf-smoke.mjs', 'browser-scenario-lifecycle.mjs']) {
      const source = await readFile(path.join(process.cwd(), 'tests/e2e', file), 'utf8')
      expect(source, file).toContain('browserDiagnosticFailures(')
    }
  })

  it('rejects a declared workflow budget when any measurement is absent', () => {
    const manifest = {
      globalBudgets: { maxInitialWebJsKb: 350, maxRouteWebJsKb: 220 },
      workflows: [{
        id: 'workflow',
        budgets: { feedbackMs: 100, cachedRequestMs: 300, fullLoadMs: 1000 },
        measurement: { report: 'report.json' },
      }],
    }
    expect(validateWorkflowReportKeys(manifest, { status: 'PASS' }, 'report.json')).toContain(
      'workflow: report.json is missing workflow measurement',
    )
    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{ id: 'workflow', feedbackMs: 1, fullLoadMs: 2 }],
    }, 'report.json')).toContain('workflow: report.json is missing numeric cachedRequestMs')

    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{
        id: 'workflow', feedbackMs: 1, cachedRequestMs: 2, fullLoadMs: 3,
        feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
      }],
    }, 'report.json')).toContain('workflow: report.json is missing route JS transfer or cache-hit evidence')

    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{
        id: 'workflow', feedbackMs: 1, cachedRequestMs: 2, fullLoadMs: 3,
        feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
        routeJsCacheHit: true, routeJsEntryCount: 1, routeJsNetworkEntryCount: 0,
        routeJsDecodedKb: 42,
      }],
    }, 'report.json')).toEqual([])
  })

  it('rejects any missing route from a full browser sweep', () => {
    expect(() => assertFullSweepRoutes(REQUIRED_FULL_SWEEP_LABELS)).not.toThrow()
    expect(() => assertFullSweepRoutes(REQUIRED_FULL_SWEEP_LABELS.slice(1))).toThrow('auth-sign-in')
  })

  it('writes canonical failure evidence even when setup returns no artifact directory', async () => {
    const registryArtifactRoot = await mkdtemp(path.join(os.tmpdir(), 'pancake-registry-'))
    tempDirs.push(registryArtifactRoot)
    await writeRegisteredScenarioReport(
      { id: 'smoke', evidenceId: 'browser.smoke', evidence: 'smoke evidence' },
      { season: 3, registryArtifactRoot },
      { outcome: { ok: false }, primaryError: new Error('setup failed'), cleanupError: null },
    )
    const report = JSON.parse(await readFile(path.join(registryArtifactRoot, 'smoke-season-3.json'), 'utf8'))
    expect(report).toMatchObject({ status: 'FAIL', scenario: 'smoke', error: 'setup failed', result: null })
  })

  it('fails canonical evidence when a runner returns no explicit PASS', async () => {
    const registryArtifactRoot = await mkdtemp(path.join(os.tmpdir(), 'pancake-registry-'))
    tempDirs.push(registryArtifactRoot)
    await writeRegisteredScenarioReport(
      { id: 'smoke', evidenceId: 'browser.smoke', evidence: 'smoke evidence' },
      { season: 2, registryArtifactRoot },
      { outcome: { ok: true, value: {} }, primaryError: null, cleanupError: null },
    )
    expect(JSON.parse(await readFile(path.join(registryArtifactRoot, 'smoke-season-2.json'), 'utf8')))
      .toMatchObject({ status: 'FAIL', error: 'Scenario returned no status instead of PASS' })
  })

  it('requires smoke and performance timing evidence for every retained season', () => {
    const manifest = { globalBudgets: {}, workflows: [] }
    const reports = [
      { scenario: 'smoke', season: 1, status: 'PASS', result: { status: 'PASS', workflowMeasurements: [] } },
      { scenario: 'performance', season: 1, status: 'PASS', result: { status: 'PASS', draftPerf: { maxLagMs: 0, maxLongTaskMs: 0, longTaskSupported: true }, homePerf: { maxLagMs: 0, maxLongTaskMs: 0, longTaskSupported: true }, load: { durationMs: 1 }, workflowMeasurements: [] } },
    ]
    expect(validateRetainedSeasonReports(manifest, reports, 1)).toEqual([])
    expect(validateRetainedSeasonReports(manifest, reports, 2)).toContain('season 2: retained smoke report is missing')
  })
})
