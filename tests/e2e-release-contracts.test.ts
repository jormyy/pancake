import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertFullSweepRoutes, REQUIRED_FULL_SWEEP_LABELS } from './e2e/browser-smoke.mjs'
import { productionBrowserFailures } from './e2e/production-web-hydration.mjs'
import { writeRegisteredScenarioReport } from './e2e/browser-scenario-registry.mjs'
import { browserCiContext } from './e2e/browser-ci-scenario.mjs'
import { BROWSER_SCENARIO_MANIFEST, fastBrowserScenarioMatrix } from './e2e/browser-scenario-manifest.mjs'
import { validateDataLatencyReport, validateManifest, validateRetainedSeasonReports, validateWorkflowReportKeys } from './e2e/performance-budgets.mjs'
import { readAppliedSchemaVersion } from './e2e/schema-provenance.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('release E2E contracts', () => {
  it('derives the mid-life migration probe from sorted repository head', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/release-soak.yml'), 'utf8')
    expect(workflow).toContain("head_name=\"$(find supabase/migrations -maxdepth 1 -name '*.sql' -exec basename {} \\; | sort | tail -1)\"")
    expect(workflow).toContain('probe_name="$head_name"')
    expect(workflow).toContain('tail -2 | head -1')
    expect(workflow).not.toContain('midlife-migration.json')
  })

  it('runs the full measured smoke sweep and enforces its workflow budgets in PR CI', async () => {
    expect(browserCiContext('smoke').args.browserFullSweep).toBe(true)
    expect(browserCiContext('performance').args.browserFullSweep).toBe(false)
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/test.yml'), 'utf8')
    expect(workflow).toContain("if: matrix.scenario == 'smoke'")
    expect(workflow).toContain('npm run perf:budget -- --require-workflow-reports')
  })

  it('runs every registered browser scenario as a required PR matrix entry', () => {
    expect(fastBrowserScenarioMatrix().include.map(({ scenario }) => scenario).sort())
      .toEqual(BROWSER_SCENARIO_MANIFEST.map(({ id }) => id).sort())
  })

  it('pins workflow dependencies and bounds every job with least privilege', async () => {
    const workflowFiles = [
      '.github/workflows/test.yml',
      '.github/workflows/release-soak.yml',
      '.github/workflows/production-readiness.yml',
    ]
    for (const file of workflowFiles) {
      const source = await readFile(path.join(process.cwd(), file), 'utf8')
      expect(source, file).toMatch(/permissions:\n\s+contents: read/)
      expect(source, file).toContain('concurrency:')
      const actionRefs = [...source.matchAll(/^\s*-?\s*uses:\s+[^@\s]+@([^\s#]+)/gm)].map((match) => match[1])
      expect(actionRefs.length, file).toBeGreaterThan(0)
      expect(actionRefs, file).toEqual(actionRefs.map(() => expect.stringMatching(/^[a-f0-9]{40}$/)))
    }

    const testWorkflow = await readFile(path.join(process.cwd(), '.github/workflows/test.yml'), 'utf8')
    expect(testWorkflow.match(/^\s{4}timeout-minutes:/gm)).toHaveLength(5)
    expect(testWorkflow).toContain('deno-version: 2.7.14')
    expect(testWorkflow).not.toMatch(/deno-version:\s*v?\d+\.x/)
  })

  it('provides a protected fail-closed hosted production gate', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/production-readiness.yml'), 'utf8')
    expect(workflow).toContain('environment: production')
    expect(workflow).toContain('test "${GITHUB_REF}" = "refs/heads/main"')
    expect(workflow).toContain('PANCAKE_LEGACY_SUPABASE_JWT_ROTATED: ${{ secrets.PANCAKE_LEGACY_SUPABASE_JWT_ROTATED }}')
    expect(workflow).not.toContain("PANCAKE_LEGACY_SUPABASE_JWT_ROTATED: '1'")
    for (const command of [
      'npm run prod:check',
      'npm run prod:data-health -- --linked',
      'npm run security:edge-auth:linked',
      'npm run security:db-catalog -- --linked',
    ]) expect(workflow).toContain(command)
    expect(workflow).toContain('if-no-files-found: error')
  })

  it('does not claim measured production performance from a clean checkout', async () => {
    const readiness = await readFile(path.join(process.cwd(), 'tests/e2e/production-readiness.mjs'), 'utf8')
    expect(readiness).not.toContain("run('npm', ['run', 'perf:budget']")
    expect(readiness).not.toContain("requirement: 'Instant-loading performance budgets pass'")
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
    expect(perfSource).toContain('managerResume.status !== 404')
    expect(perfSource).toContain('await selectPerfLeague(session, fixture.league.name)')
    expect(perfSource).toContain('await ensurePerfSeasonWeek(supabase, fixture.leagueSeason.season_year, resourceOwner)')
    expect(perfSource).not.toContain('stale auction draft cleanup')
    expect(registrySource).toContain('(resourceOwner) => scenario.run({ ...context, resourceOwner })')
  })

  it('binds post-migration data latency evidence to repository schema head', async () => {
    expect(readAppliedSchemaVersion(() => [{ version: '20260709100034' }])).toBe('20260709100034')
    const manifest = { workflows: [], globalBudgets: { maxDbQueryMs: 300, fullWorkflowMs: 1000 } }
    expect(validateDataLatencyReport(manifest, {
      status: 'PASS',
      schemaVersion: '20260709100034',
      repositorySchemaVersion: '20260709100033',
      workflows: [],
    }, true)).toContain('data latency report schema 20260709100034 does not match repository head 20260709100033')
    expect(validateDataLatencyReport(manifest, { status: 'PASS', workflows: [] }, true)).toEqual(expect.arrayContaining([
      'data latency report is missing applied schema version',
      'data latency report is missing repository schema version',
    ]))

    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/release-soak.yml'), 'utf8')
    expect(workflow.indexOf('Run coverage-enforcing soak')).toBeLessThan(workflow.indexOf('Measure post-migration ranked workflow data latency'))
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
    expect(productionBrowserFailures({ consoleOutput: 'console unavailable: transport failed', errorOutput: '' }))
      .toContain('console diagnostics unavailable')
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
      workflowMeasurements: [{ id: 'workflow', feedbackMs: 1, coldFullLoadMs: 2 }],
    }, 'report.json')).toContain('workflow: report.json is missing numeric warmCachedRequestMs')

    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{
        id: 'workflow', feedbackMs: 1, warmCachedRequestMs: 2, coldFullLoadMs: 3,
        feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
      }],
    }, 'report.json')).toContain('workflow: report.json is missing route JS transfer or cache-hit evidence')

    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{
        id: 'workflow', feedbackMs: 1, warmCachedRequestMs: 2, coldFullLoadMs: 3,
        feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
        routeJsCacheHit: true, routeJsEntryCount: 1, routeJsNetworkEntryCount: 0,
        routeJsDecodedKb: 42, routeJsEncodedKb: 42,
        routeJsLedger: [{ url: 'https://app.test/route.js', encodedBodySize: 43008, decodedBodySize: 43008 }],
      }],
    }, 'report.json')).toEqual([])
  })

  it('rejects oversized cached chunks and report-controlled data budgets', () => {
    const workflow = {
      id: 'workflow', budgets: { feedbackMs: 100, cachedRequestMs: 300, fullLoadMs: 1000 },
      measurement: { report: 'report.json' },
    }
    const manifest = {
      globalBudgets: { maxInitialWebJsKb: 350, maxRouteWebJsKb: 220, maxDbQueryMs: 100, fullWorkflowMs: 1000 },
      workflows: [workflow],
    }
    const routeFailures = validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{
        id: 'workflow', feedbackMs: 1, warmCachedRequestMs: 2, coldFullLoadMs: 3,
        feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
        routeJsCacheHit: true, routeJsEntryCount: 1, routeJsNetworkEntryCount: 0,
        routeJsDecodedKb: 500, routeJsEncodedKb: 500,
        routeJsLedger: [{ url: 'https://app.test/huge.js', encodedBodySize: 512000, decodedBodySize: 512000 }],
      }],
    }, 'report.json')
    expect(routeFailures).toContain('workflow: route JS 500KB exceeds 220KB')

    const measuredRoute = {
      id: 'workflow', feedbackMs: 1, feedbackObserved: true, feedbackInteraction: 'real-action',
      routeWebJsKb: 1, routeJsEncodedKb: 1, routeJsDecodedKb: 2,
      routeJsCacheHit: false, routeJsEntryCount: 1, routeJsNetworkEntryCount: 1,
      routeJsLedger: [{ url: 'https://app.test/route.js', encodedBodySize: 1024, decodedBodySize: 2048 }],
    }
    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{ ...measuredRoute, warmCachedRequestMs: 2, coldFullLoadMs: 1500 }],
    }, 'report.json')).toContain('workflow: report.json cold full load 1500ms exceeds 1000ms')
    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{ ...measuredRoute, warmCachedRequestMs: 400, coldFullLoadMs: 3 }],
    }, 'report.json')).toContain('workflow: report.json warmed cached request 400ms exceeds 300ms')

    const dataFailures = validateDataLatencyReport(manifest, {
      status: 'PASS', schemaVersion: '1', repositorySchemaVersion: '1',
      budgets: { dataRequestMs: 999999, workflowTotalMs: 999999 },
      workflows: [{ id: 'workflow', totalMedianMs: 1500, steps: [{ label: 'query', status: 'PASS', medianMs: 100, maxMs: 100 }] }],
    }, true)
    expect(dataFailures).toEqual(expect.arrayContaining([
      'data latency request budget 999999 does not match manifest 100',
      'data latency workflow budget 999999 does not match manifest 1000',
      'workflow: data latency total 1500ms exceeds 1000ms',
    ]))
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
      { season: 3, registryArtifactRoot, provenance: { commitSha: 'a', runId: 'run', bundleDigest: 'bundle' } },
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
      { season: 2, registryArtifactRoot, provenance: { commitSha: 'a', runId: 'run', bundleDigest: 'bundle' } },
      { outcome: { ok: true, value: {} }, primaryError: null, cleanupError: null },
    )
    expect(JSON.parse(await readFile(path.join(registryArtifactRoot, 'smoke-season-2.json'), 'utf8')))
      .toMatchObject({ status: 'FAIL', error: 'Scenario returned no status instead of PASS' })
  })

  it('rejects copied evidence from another commit, run, or bundle', () => {
    const expected = { commitSha: 'a'.repeat(40), runId: 'run-current', bundleDigest: 'b'.repeat(64) }
    const manifest = { globalBudgets: { maxInitialWebJsKb: 350, maxRouteWebJsKb: 220 }, workflows: [] }
    const failures = validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      provenance: { commitSha: 'c'.repeat(40), runId: 'run-stale', bundleDigest: 'd'.repeat(64) },
      workflowMeasurements: [],
    }, 'report.json', expected)
    expect(failures).toEqual(expect.arrayContaining([
      expect.stringContaining('provenance commitSha'),
      expect.stringContaining('provenance runId'),
      expect.stringContaining('provenance bundleDigest'),
    ]))
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
