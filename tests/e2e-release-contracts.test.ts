import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

import { assertFullSweepRoutes, REQUIRED_FULL_SWEEP_LABELS } from './e2e/browser-smoke.mjs'
import { buildDraftVisibleObservationScript, requireAffectedMatchup } from './e2e/browser-perf-smoke.mjs'
import { productionBrowserFailures } from './e2e/production-web-hydration.mjs'
import { writeRegisteredScenarioReport } from './e2e/browser-scenario-registry.mjs'
import { browserCiContext } from './e2e/browser-ci-scenario.mjs'
import { BROWSER_SCENARIO_MANIFEST, fastBrowserScenarioMatrix } from './e2e/browser-scenario-manifest.mjs'
import { DATA_LATENCY_STEP_KEYS } from './e2e/data-latency-contract.mjs'
import { runDataLatencyWorkflow } from './e2e/data-latency-bench.mjs'
import { requireEnv } from './e2e/env.mjs'
import { validateBrowserMutationLoad, validateBrowserPerfReport, validateDataLatencyReport, validateManifest, validateRetainedSeasonReports, validateWorkflowReportKeys } from './e2e/performance-budgets.mjs'
import { readAppliedSchemaVersion } from './e2e/schema-provenance.mjs'
import { digestReleaseBundle, selectRepositoryCommit } from './e2e/release-provenance.mjs'
import { planReleaseMigrations, planReleaseMigrationsFromHistory, validateAppliedMigrationDelta } from './e2e/release-soak-migration-plan.mjs'
import { stampReleaseProvenance } from '../scripts/stamp-release-provenance.mjs'
import { digestEdgeArtifact, stampEdgeReleaseProvenance } from '../scripts/stamp-edge-release-provenance.mjs'
import { validateReleaseBaselineProvenance } from './e2e/release-baseline-provenance.mjs'
import { validateReleaseCompatibilityEvidence } from './e2e/release-runtime-compatibility.mjs'
import { REQUIRED_MUTATION_SCENARIOS, runMutationScenarios } from './e2e/release-mutation-compatibility.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const WORKER_TEMPLATE = [
  "const VERSION = 'pancake-dev'",
  "const PRECACHE_URLS = ['/']",
  "const PUBLIC_ASSET_URLS = []",
  "const PUBLIC_ASSET_HASHES = {}",
  "const SHELL_ROUTES = ['/']",
  '',
].join('\n')

const SHELL_HTML =
  '<html><head><meta name="pancake-release" content="pancake-build"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/_expo/static/css/app.css"></head><body><img src="/boot-logo.png">' +
  '<script src="/_expo/static/js/web/entry-abc.js" defer></script>' +
  // Must not reach the manifest: the worker only serves its own origin.
  '<script src="//cdn.example.com/off-origin.js" defer></script>' +
  '<script src="https://cdn.example.com/absolute.js" defer></script>' +
  '</body></html>'

describe('release E2E contracts', () => {
  it('uses one notification tag so repeated pushes replace the visible notification', async () => {
    const listeners = new Map<string, (event: { waitUntil: (pending: Promise<unknown>) => void }) => void>()
    const visible = new Map<string, unknown>()
    let displayed = 0
    runInNewContext(await readFile(path.join(process.cwd(), 'public/sw.js'), 'utf8'), { self: {
      addEventListener: (name: string, listener: (event: { waitUntil: (pending: Promise<unknown>) => void }) => void) => listeners.set(name, listener),
      registration: { showNotification: async (_title: string, options: { tag?: string; renotify?: boolean }) => {
        displayed++
        expect(options.renotify).toBe(true)
        visible.set(options.tag ?? String(displayed), options)
      } },
    } })
    const pending: Promise<unknown>[] = []
    for (let index = 0; index < 2; index++) listeners.get('push')!({ waitUntil: task => pending.push(task) })
    await Promise.all(pending)
    expect(displayed).toBe(2)
    expect([...visible.keys()]).toEqual(['pancake'])
  })

  it('rejects mixed local and hosted E2E data targets', () => {
    expect(() => requireEnv({
      supabaseUrl: 'http://127.0.0.1:54321',
      apiBaseUrl: 'https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/api',
    }, ['supabaseUrl', 'apiBaseUrl'])).toThrow('different deployment targets')

    expect(requireEnv({
      supabaseUrl: 'http://localhost:54321',
      apiBaseUrl: 'http://127.0.0.1:54321/functions/v1/api',
    }, ['supabaseUrl', 'apiBaseUrl'])).toMatchObject({
      supabaseUrl: 'http://localhost:54321',
      apiBaseUrl: 'http://127.0.0.1:54321/functions/v1/api',
    })
  })

  it('derives the full deployed-to-HEAD migration range', async () => {
    expect(planReleaseMigrations([
      '20260709100003_c.sql',
      '20260709100001_a.sql',
      '20260709100002_b.sql',
    ], '20260709100001')).toEqual({
      deployedVersion: '20260709100001',
      repositoryHead: '20260709100003',
      pendingFiles: ['20260709100002_b.sql', '20260709100003_c.sql'],
      pendingVersions: ['20260709100002', '20260709100003'],
    })
    expect(validateAppliedMigrationDelta({
      beforeVersions: ['20260709100001'],
      afterVersions: ['20260709100001', '20260709100002', '20260709100003'],
      expectedVersions: ['20260709100002', '20260709100003'],
    })).toEqual({ appliedVersions: ['20260709100002', '20260709100003'], failures: [] })
    expect(validateAppliedMigrationDelta({
      beforeVersions: ['20260709100001'],
      afterVersions: ['20260709100001', '20260709100003'],
      expectedVersions: ['20260709100002', '20260709100003'],
    }).failures).not.toEqual([])

    const filenames = ['1_initial.sql', '2_add_lineups.sql', '3_add_trades.sql']
    expect(planReleaseMigrationsFromHistory(filenames, [
      { version: '1', name: 'initial' },
      { version: '2', name: 'add_lineups' },
    ])).toMatchObject({
      deployedVersion: '2',
      pendingFiles: ['3_add_trades.sql'],
    })
    expect(() => planReleaseMigrationsFromHistory(filenames, [
      { version: '1', name: 'initial' },
      { version: '3', name: 'add_trades' },
    ])).toThrow('diverges at row 2')
    expect(() => planReleaseMigrationsFromHistory(filenames, [
      { version: '1', name: 'renamed_initial' },
    ])).toThrow('diverges at row 1')
    expect(() => planReleaseMigrationsFromHistory(filenames, [
      { version: '1', name: 'initial' },
      { version: '2', name: 'add_lineups' },
      { version: '3', name: 'add_trades' },
      { version: '4', name: 'unknown' },
    ])).toThrow('not present in the repository')

  })

  it('runs the full measured smoke sweep and enforces its workflow budgets in PR CI', async () => {
    expect(browserCiContext('smoke').args.browserFullSweep).toBe(true)
    expect(browserCiContext('performance').args.browserFullSweep).toBe(false)
  })

  it('runs every registered browser scenario as a required PR matrix entry', () => {
    expect(fastBrowserScenarioMatrix().include.map(({ scenario }) => scenario).sort())
      .toEqual(BROWSER_SCENARIO_MANIFEST.map(({ id }) => id).sort())
  })

  it('refuses to stamp a worker that declares no precache manifest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-release-noprecache-'))
    tempDirs.push(root)
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'sw.js'), "const VERSION = 'pancake-dev'\n")
    await writeFile(path.join(root, 'dist', 'index.html'), SHELL_HTML)
    await Promise.all([
      writeFile(path.join(root, 'app.json'), '{}\n'),
      writeFile(path.join(root, 'package.json'), '{}\n'),
      writeFile(path.join(root, 'package-lock.json'), '{}\n'),
      writeFile(path.join(root, 'vercel.json'), '{}\n'),
    ])
    await expect(stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })).rejects.toThrow(
      /PRECACHE_URLS/,
    )
  })

  it('stamps a self-consistent marker and build-specific cache version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-release-bundle-'))
    tempDirs.push(root)
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'app.js'), 'console.log("release")\n')
    await writeFile(path.join(root, 'dist', 'sw.js'), WORKER_TEMPLATE)
    await writeFile(path.join(root, 'dist', 'index.html'), SHELL_HTML)
    for (const [file, body] of Object.entries({
      '_expo/static/js/web/entry-abc.js': 'console.log("boot")',
      'sign-in.html': '<script src="/_expo/static/js/web/sign-in-abc.js"></script>',
      '_expo/static/js/web/sign-in-abc.js': 'console.log("public login")',
      '_expo/static/css/app.css': 'body{margin:0}',
      'manifest.webmanifest': '{}',
      'pwa-192.png': 'fixture image',
      'boot-logo.png': 'fixture boot image',
    })) {
      await mkdir(path.dirname(path.join(root, 'dist', file)), { recursive: true })
      await writeFile(path.join(root, 'dist', file), body)
    }
    await mkdir(path.join(root, 'dist', 'assets', 'fonts'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'assets', 'fonts', 'MaterialIcons.abc123.ttf'), 'font')
    // A font the app never names must stay out, even though it is in the build.
    await writeFile(path.join(root, 'dist', 'assets', 'fonts', 'Outfit_900Black.def456.ttf'), 'font')
    await mkdir(path.join(root, 'app'), { recursive: true })
    await writeFile(path.join(root, 'app', '_layout.tsx'), "import MaterialIcons from '@expo/vector-icons/MaterialIcons'\n")
    await Promise.all([
      writeFile(path.join(root, 'app.json'), '{}\n'),
      writeFile(path.join(root, 'package.json'), '{}\n'),
      writeFile(path.join(root, 'package-lock.json'), '{}\n'),
      writeFile(path.join(root, 'vercel.json'), '{}\n'),
    ])

    const marker = await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })
    expect(marker).toEqual({
      commitSha: 'a'.repeat(40),
      bundleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      deploymentInputs: ['app.json', 'package.json', 'package-lock.json', 'vercel.json'],
      artifact: expect.objectContaining({ version: 1, files: expect.any(Array), inputs: expect.any(Array) }),
    })
    expect(await digestReleaseBundle(root)).toBe(marker.bundleDigest)
    expect(JSON.parse(await readFile(path.join(root, 'dist', 'release-provenance.json'), 'utf8'))).toEqual(marker)

    const firstWorker = await readFile(path.join(root, 'dist', 'sw.js'), 'utf8')
    const publicAssets = JSON.parse(/const PUBLIC_ASSET_URLS = (\[[^\n]*\])/.exec(firstWorker)![1])
    const addressed = (name: string, extension: string, body: string) =>
      `/assets/pwa/${name}.${createHash('sha256').update(body).digest('hex').slice(0, 32)}.${extension}`
    const bootLogo = addressed('boot-logo', 'png', 'fixture boot image')
    const installIcon = addressed('pwa-192', 'png', 'fixture image')
    const manifest = addressed('manifest', 'webmanifest', '{}')
    const entry = addressed('entry-abc', 'js', 'console.log("boot")')
    expect(publicAssets).toEqual([
      '/_expo/static/css/app.css', '/_expo/static/js/web/entry-abc.js', '/_expo/static/js/web/sign-in-abc.js',
      '/assets/fonts/MaterialIcons.abc123.ttf', '/assets/fonts/Outfit_900Black.def456.ttf',
      bootLogo, installIcon, manifest, entry, '/boot-logo.png', '/manifest.webmanifest', '/pwa-192.png',
    ].sort())
    const publicHashes = JSON.parse(/const PUBLIC_ASSET_HASHES = (\{[^\n]*\})/.exec(firstWorker)![1])
    expect(Object.keys(publicHashes)).toEqual(['/', ...publicAssets])
    expect(Object.values(publicHashes)).toEqual(Array.from({ length: publicAssets.length + 1 }, () => expect.stringMatching(/^[a-f0-9]{64}$/)))
    expect(publicHashes['/']).toBe(createHash('sha256').update(await readFile(path.join(root, 'dist', 'index.html'))).digest('hex'))
    expect(publicAssets).not.toContain('/app.js')
    expect(firstWorker).toContain('const SHELL_ROUTES = ["/","/index.html","/sign-in","/sign-in.html"]')

    expect(firstWorker).toMatch(/pancake-aaaaaaaaaaaa-[a-f0-9]{12}/)
    // The worker must precache what the shell boots from, or the reload that
    // follows an update re-downloads the whole bundle over the network.
    expect(firstWorker).toContain(
      `const PRECACHE_URLS = ${JSON.stringify([
        '/', '/_expo/static/css/app.css', '/_expo/static/js/web/sign-in-abc.js',
        '/assets/fonts/MaterialIcons.abc123.ttf', bootLogo, manifest, entry,
      ].sort())}`,
    )
    await writeFile(path.join(root, 'dist', 'app.js'), 'console.log("rebuilt release")\n')
    await writeFile(path.join(root, 'dist', 'sw.js'), WORKER_TEMPLATE)
    const rebuiltMarker = await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })
    const rebuiltWorker = await readFile(path.join(root, 'dist', 'sw.js'), 'utf8')
    expect(rebuiltWorker).not.toBe(firstWorker)
    expect(await digestReleaseBundle(root)).toBe(rebuiltMarker.bundleDigest)

    await writeFile(path.join(root, 'vercel.json'), '{"rewrites":[]}\n')
    const routingDigest = await digestReleaseBundle(root)
    expect(routingDigest).not.toBe(rebuiltMarker.bundleDigest)
    await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
    expect(await digestReleaseBundle(root)).not.toBe(routingDigest)
    await rm(path.join(root, 'dist', '_expo/static/js/web/sign-in-abc.js'))
    await expect(stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })).rejects.toThrow(/Required boot asset is missing/)
    await writeFile(path.join(root, 'dist', '_expo/static/js/web/sign-in-abc.js'), 'console.log("public login")')
    await rm(path.join(root, 'dist', '_expo/static/js/web/entry-abc.js'))
    await rm(path.join(root, 'dist', entry))
    await expect(stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })).rejects.toThrow(/Required boot asset is missing/)
  })

  it('rejects release provenance for a SHA other than the checked-out commit', () => {
    const headCommit = 'a'.repeat(40)
    expect(selectRepositoryCommit({ headCommit, expectedCommit: headCommit })).toBe(headCommit)
    expect(() => selectRepositoryCommit({ headCommit, expectedCommit: 'b'.repeat(40) }))
      .toThrow(`expected ${'b'.repeat(40)} but HEAD is ${headCommit}`)
  })

  it('bakes Edge provenance from source rather than mutable environment values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-edge-release-'))
    tempDirs.push(root)
    const functionsRoot = path.join(root, 'functions')
    const metadataPath = path.join(functionsRoot, '_shared/releaseMetadata.ts')
    await mkdir(path.dirname(metadataPath), { recursive: true })
    await writeFile(path.join(functionsRoot, 'api.ts'), 'export const api = true\n')
    await writeFile(path.join(functionsRoot, 'api.test.ts'), 'throw new Error("not deployed")\n')
    await writeFile(metadataPath, 'placeholder\n')

    const first = await stampEdgeReleaseProvenance({
      commitSha: 'a'.repeat(40),
      functionsRoot,
      metadataPath,
    })
    expect(first.edgeArtifactDigest).toBe(await digestEdgeArtifact({ functionsRoot, metadataPath }))
    expect(await readFile(metadataPath, 'utf8')).toContain(`RELEASE_COMMIT_SHA = '${'a'.repeat(40)}'`)

    process.env.PANCAKE_RELEASE_SHA = 'b'.repeat(40)
    expect(await digestEdgeArtifact({ functionsRoot, metadataPath })).toBe(first.edgeArtifactDigest)
    expect(await readFile(metadataPath, 'utf8')).toContain(`RELEASE_COMMIT_SHA = '${'a'.repeat(40)}'`)
    delete process.env.PANCAKE_RELEASE_SHA
  })

  it('covers Edge dependencies outside the functions tree and gateway configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-edge-inputs-'))
    tempDirs.push(root)
    const functionsRoot = path.join(root, 'supabase/functions')
    const metadataPath = path.join(functionsRoot, '_shared/releaseMetadata.ts')
    const dependencyPath = path.join(root, 'constants/runtime.ts')
    const configPath = path.join(root, 'supabase/config.toml')
    await mkdir(path.dirname(metadataPath), { recursive: true })
    await mkdir(path.dirname(dependencyPath), { recursive: true })
    await writeFile(metadataPath, 'placeholder\n')
    await writeFile(dependencyPath, 'export const runtimeValue = 1\n')
    await writeFile(configPath, '[functions.api]\nverify_jwt = false\n')
    await writeFile(path.join(functionsRoot, 'api.ts'), "import { runtimeValue } from '../../constants/runtime.ts'\nexport { runtimeValue }\n")

    const lockPath = path.join(root, 'deno.lock')
    await writeFile(lockPath, '{"version":"5"}\n')
    const options = { functionsRoot, metadataPath, artifactRoot: root, deploymentInputPaths: [configPath, lockPath] }
    const initial = await digestEdgeArtifact(options)
    await writeFile(dependencyPath, 'export const runtimeValue = 2\n')
    const dependencyChanged = await digestEdgeArtifact(options)
    await writeFile(configPath, '[functions.api]\nverify_jwt = true\n')
    const configChanged = await digestEdgeArtifact(options)
    await writeFile(lockPath, '{"version":"5","remote":{"dependency":"digest"}}\n')
    const lockChanged = await digestEdgeArtifact(options)

    expect(dependencyChanged).not.toBe(initial)
    expect(configChanged).not.toBe(dependencyChanged)
    expect(lockChanged).not.toBe(configChanged)
  })

  it('requires independent deployed frontend and Edge attestations', () => {
    expect(validateReleaseBaselineProvenance({
      frontend: { commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) },
      edge: {
        ok: true,
        service: 'pancake-supabase-api',
        runtime: 'supabase-edge',
        commitSha: 'c'.repeat(40),
        edgeArtifactDigest: 'd'.repeat(64),
      },
    })).toEqual([])
    expect(validateReleaseBaselineProvenance({
      frontend: { commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) },
      edge: { ok: true, service: 'pancake-supabase-api', runtime: 'supabase-edge', commitSha: 'c'.repeat(40) },
    })).toContain('deployed Edge edgeArtifactDigest is invalid')
  })

  it('blocks removed-column and removed-route cross-version incompatibilities', async () => {
    const candidateSha = 'a'.repeat(40)
    const deployedFrontendSha = 'b'.repeat(40)
    const deployedEdgeSha = 'c'.repeat(40)
    const passingPairs = [
      {
        id: 'deployed-frontend-candidate-edge',
        status: 'PASS',
        frontend: { commitSha: deployedFrontendSha, bundleDigest: 'd'.repeat(64) },
        edge: { commitSha: candidateSha, edgeArtifactDigest: 'e'.repeat(64) },
        mutationEvidenceIds: [...REQUIRED_MUTATION_SCENARIOS],
      },
      {
        id: 'candidate-frontend-deployed-edge',
        status: 'PASS',
        frontend: { commitSha: candidateSha, bundleDigest: 'f'.repeat(64) },
        edge: { commitSha: deployedEdgeSha, edgeArtifactDigest: '0'.repeat(64) },
        mutationEvidenceIds: [...REQUIRED_MUTATION_SCENARIOS],
      },
      {
        id: 'deployed-frontend-deployed-edge',
        status: 'PASS',
        frontend: { commitSha: deployedFrontendSha, bundleDigest: 'd'.repeat(64) },
        edge: { commitSha: deployedEdgeSha, edgeArtifactDigest: '0'.repeat(64) },
        mutationEvidenceIds: [...REQUIRED_MUTATION_SCENARIOS],
      },
    ]
    const input = {
      candidateSha,
      deployedFrontendSha,
      deployedEdgeSha,
      deployedFrontendArtifact: {
        verifiedBundleDigest: '1'.repeat(64),
        liveBundleDigest: '1'.repeat(64),
        compatibilityBundleDigest: 'd'.repeat(64),
      },
      pairs: passingPairs,
    }
    expect(validateReleaseCompatibilityEvidence(input)).toEqual([])
    expect(validateReleaseCompatibilityEvidence({
      ...input,
      pairs: passingPairs.map((pair) => pair.id === 'candidate-frontend-deployed-edge'
        ? { ...pair, status: 'FAIL', error: 'removed column current_roster_id' }
        : pair),
    })).toContain('candidate-frontend-deployed-edge mutation contract failed: removed column current_roster_id')
    expect(validateReleaseCompatibilityEvidence({
      ...input,
      pairs: passingPairs.map((pair) => pair.id === 'deployed-frontend-candidate-edge'
        ? { ...pair, status: 'FAIL', error: 'removed route /league/legacy-summary' }
        : pair),
    })).toContain('deployed-frontend-candidate-edge mutation contract failed: removed route /league/legacy-summary')
    expect(validateReleaseCompatibilityEvidence({
      ...input,
      pairs: passingPairs.filter((pair) => pair.id !== 'deployed-frontend-deployed-edge'),
    })).toContain('deployed-frontend-deployed-edge evidence is missing')
    expect(validateReleaseCompatibilityEvidence({
      ...input,
      pairs: passingPairs.map((pair) => pair.id === 'deployed-frontend-deployed-edge'
        ? { ...pair, status: 'FAIL', error: 'removed RPC create_league' }
        : pair),
    })).toContain('deployed-frontend-deployed-edge mutation contract failed: removed RPC create_league')
    expect(validateReleaseCompatibilityEvidence({
      ...input,
      deployedFrontendArtifact: { ...input.deployedFrontendArtifact, verifiedBundleDigest: '' },
    })).toContain('deployed frontend complete artifact digest was not verified')
    expect(validateReleaseCompatibilityEvidence({
      ...input,
      deployedFrontendArtifact: { ...input.deployedFrontendArtifact, verifiedBundleDigest: '2'.repeat(64) },
    })).toContain('deployed frontend complete artifact digest was not verified')

  })

  it('fails mixed-version evidence when a real mutation runner observes a removed route', async () => {
    const scenarios = await runMutationScenarios({
      runScenario: async (id: string) => {
        if (id === 'trade-proposal') throw new Error('POST /trades/propose returned HTTP 404')
        return { status: 'PASS' }
      },
    })
    expect(scenarios.find((scenario) => scenario.id === 'trade-proposal')).toEqual({
      id: 'trade-proposal',
      status: 'FAIL',
      error: 'POST /trades/propose returned HTTP 404',
    })
    expect(scenarios.filter((scenario) => scenario.status === 'PASS')).toHaveLength(REQUIRED_MUTATION_SCENARIOS.length - 1)
  })

  it('requires every declared global performance budget', () => {
    const failures = validateManifest({ version: 1, workflows: [], globalBudgets: {} })
    for (const key of ['longTaskMs', 'maxInitialWebJsKb', 'maxRouteWebJsKb', 'maxDbQueryMs']) {
      expect(failures).toContain(`globalBudgets.${key} must be a positive number`)
    }
    expect(failures).toContain('globalBudgets.minHeartbeatSamples must be a positive integer')
  })

  it('requires every per-workflow performance budget', () => {
    const workflow = {
      id: 'workflow', rank: 1, name: 'Workflow', route: '/', frequency: 'daily', pain: 'slow', owner: 'team',
      criticalPath: ['a', 'b', 'c'], measurement: { primary: 'browser', report: 'report.json' },
      budgets: { feedbackMs: 100, cachedRequestMs: 300, fullLoadMs: 1000 },
    }
    const manifest = {
      version: 1,
      workflows: [workflow],
      globalBudgets: { instantFeedbackMs: 100, cachedRequestMs: 300, fullWorkflowMs: 1000 },
    }
    for (const key of ['feedbackMs', 'cachedRequestMs', 'fullLoadMs']) {
      const mutated = structuredClone(manifest)
      delete mutated.workflows[0].budgets[key as keyof typeof workflow.budgets]
      expect(validateManifest(mutated)).toContain(`workflow: budgets.${key} must be a positive number`)
    }
  })

  it('rejects browser performance PASS evidence without numeric long-task and load measurements', () => {
    const manifest = {
      globalBudgets: {
        minHeartbeatSamples: 10,
        maxHeartbeatLagMs: 600,
        longTaskMs: 50,
        maxMutationLoopMs: 30000,
        maxInitialWebJsKb: 700,
        maxRouteWebJsKb: 220,
      },
      workflows: [],
    }
    const failures = validateBrowserPerfReport(manifest, {
      status: 'PASS',
      draftPerf: { maxLagMs: 1, longTaskSupported: true },
      homePerf: { maxLagMs: 1, longTaskSupported: true, maxLongTaskMs: Number.NaN },
      workflowMeasurements: [],
    })
    expect(failures).toEqual(expect.arrayContaining([
      'draft max long task must be a finite nonnegative number',
      'home max long task must be a finite nonnegative number',
      'mutation loop duration must be a finite nonnegative number',
    ]))
  })

  it('rejects missing, nonnumeric, and negative browser heartbeat evidence', () => {
    const manifest = {
      globalBudgets: {
        minHeartbeatSamples: 10,
        maxHeartbeatLagMs: 600,
        longTaskMs: 50,
        maxMutationLoopMs: 30000,
        maxInitialWebJsKb: 700,
        maxRouteWebJsKb: 220,
      },
      workflows: [],
    }
    for (const maxLagMs of [undefined, '1', Number.NaN, -1]) {
      const failures = validateBrowserPerfReport(manifest, {
        status: 'PASS',
        draftPerf: { maxLagMs, maxLongTaskMs: 1, longTaskSupported: true },
        homePerf: { maxLagMs, maxLongTaskMs: 1, longTaskSupported: true },
        load: { durationMs: 1 },
        workflowMeasurements: [],
      })
      expect(failures).toEqual(expect.arrayContaining([
        'draft heartbeat lag must be a finite nonnegative number',
        'home heartbeat lag must be a finite nonnegative number',
      ]))
    }
  })

  it('requires complete and internally consistent browser heartbeat and mutation evidence', () => {
    const manifest = {
      globalBudgets: {
        minHeartbeatSamples: 10,
        maxHeartbeatLagMs: 600,
        longTaskMs: 50,
        maxMutationLoopMs: 30000,
        maxInitialWebJsKb: 700,
        maxRouteWebJsKb: 220,
      },
      workflows: [],
    }
    const draftMutation = {
      awayPoints: 2,
      bidAmount: 1,
      bidderId: '11111111-1111-4111-8111-111111111111',
      homePoints: 1,
      matchupId: '22222222-2222-4222-8222-222222222222',
      nominationId: '33333333-3333-4333-8333-333333333333',
    }
    const homeMutation = { ...draftMutation, bidAmount: null, bidderId: null, nominationId: null }
    const report = {
      status: 'PASS',
      draftPerf: { ticks: 10, maxLagMs: 1, maxLongTaskMs: 1, longTaskSupported: true },
      homePerf: { ticks: 10, maxLagMs: 1, maxLongTaskMs: 1, longTaskSupported: true },
      load: {
        durationMs: 3,
        draft: {
          count: 2,
          durationMs: 3,
          mutations: [draftMutation, draftMutation],
          visibleUpdate: {
            kind: 'auction-bid', entityId: draftMutation.nominationId,
            bidAmount: draftMutation.bidAmount, bidderId: draftMutation.bidderId,
            leaderText: "You're leading", observed: true,
            observedText: '$1 | You\'re leading | 2 bids',
          },
        },
        home: {
          count: 2,
          durationMs: 2,
          mutations: [homeMutation, homeMutation],
          visibleUpdate: {
            kind: 'matchup-score', entityId: homeMutation.matchupId,
            homePoints: homeMutation.homePoints, awayPoints: homeMutation.awayPoints,
            observed: true, observedText: '1.0 vs 2.0',
          },
        },
      },
      workflowMeasurements: [],
    }
    expect(validateBrowserPerfReport(manifest, report)).toEqual([])

    expect(validateBrowserMutationLoad('draft', report.load.draft)).toEqual([])
    expect(validateBrowserMutationLoad('home', report.load.home)).toEqual([])
    for (const mutation of [
      {},
      { ...draftMutation, bidAmount: '1' },
      { ...draftMutation, bidderId: null },
      { ...draftMutation, matchupId: null },
      { ...draftMutation, homePoints: Number.NaN },
    ]) {
      expect(validateBrowserMutationLoad('draft', {
        count: 2, durationMs: 1, mutations: [mutation, mutation], visibleUpdate: report.load.draft.visibleUpdate,
      }).length)
        .toBeGreaterThan(0)
    }
    for (const mutation of [
      {},
      { ...homeMutation, bidAmount: 1 },
      { ...homeMutation, bidderId: draftMutation.bidderId },
      { ...homeMutation, nominationId: draftMutation.nominationId },
      { ...homeMutation, awayPoints: Number.NaN },
    ]) {
      expect(validateBrowserMutationLoad('home', {
        count: 2, durationMs: 1, mutations: [mutation, mutation], visibleUpdate: report.load.home.visibleUpdate,
      }).length)
        .toBeGreaterThan(0)
    }

    for (const ticks of [1, 9]) {
      expect(validateBrowserPerfReport(manifest, {
        ...report,
        draftPerf: { ...report.draftPerf, ticks },
        homePerf: { ...report.homePerf, ticks },
      })).toEqual(expect.arrayContaining([
        `draft heartbeat ticks ${ticks} are below minimum 10`,
        `home heartbeat ticks ${ticks} are below minimum 10`,
      ]))
    }

    for (const value of [undefined, 0, '1', Number.NaN, -1]) {
      expect(validateBrowserPerfReport(manifest, {
        ...report,
        draftPerf: { ...report.draftPerf, ticks: value },
        homePerf: { ...report.homePerf, ticks: value },
      })).toEqual(expect.arrayContaining([
        'draft heartbeat ticks must be a positive integer',
        'home heartbeat ticks must be a positive integer',
      ]))
      expect(validateBrowserPerfReport(manifest, {
        ...report,
        load: {
          ...report.load,
          draft: { ...report.load.draft, count: value },
          home: { ...report.load.home, count: value },
        },
      })).toEqual(expect.arrayContaining([
        'draft mutation count must be a positive integer',
        'home mutation count must be a positive integer',
      ]))
    }

    expect(validateBrowserPerfReport(manifest, {
      ...report,
      load: { ...report.load, home: { ...report.load.home, count: 1 } },
    })).toEqual(expect.arrayContaining([
      'home mutation ledger must match its count',
      'draft and home mutation counts must match',
    ]))
    expect(validateBrowserPerfReport(manifest, {
      ...report,
      load: { ...report.load, durationMs: 2 },
    })).toContain('mutation loop duration must equal the slowest surface')

    expect(() => requireAffectedMatchup(
      { data: null, error: null, status: 204 },
      draftMutation.matchupId,
      1,
    )).toThrow('affected no matching row')
    expect(validateBrowserMutationLoad('home', {
      ...report.load.home,
      visibleUpdate: { ...report.load.home.visibleUpdate, observed: false },
    })).toContain('home visible update was not observed')
    expect(validateBrowserMutationLoad('draft', {
      ...report.load.draft,
      visibleUpdate: { ...report.load.draft.visibleUpdate, observedText: 'unrelated page text' },
    })).toContain('draft visible update text does not match the final mutation')
    expect(validateBrowserMutationLoad('draft', {
      ...report.load.draft,
      visibleUpdate: { ...report.load.draft.visibleUpdate, observedText: '$2 | You\'re leading | 2 bids' },
    })).toContain('draft visible update text does not match the final mutation')
    expect(validateBrowserMutationLoad('home', {
      ...report.load.home,
      visibleUpdate: { ...report.load.home.visibleUpdate, observedText: '1.0 vs 3.0' },
    })).toContain('home visible update text does not match the final mutation')
  })

  it('rejects draft visibility assembled from final history and stale live state', () => {
    const expected = { amount: 25, leaderText: "You're leading", bidLabel: '24 bids' }
    const liveStateLabel = "$23 | You're leading | 23 bids"
    const bodyText = `$25\n24 bids\n${liveStateLabel}`
    const observe = (label: string) => {
      const querySelector = (selector: string) => {
        expect(selector).toBe('[data-testid="auction-live-state"]')
        return { getAttribute: (name: string) => name === 'aria-label' ? label : null }
      }
      return JSON.parse(runInNewContext(buildDraftVisibleObservationScript(expected), {
        document: { body: { innerText: bodyText }, querySelector },
      }))
    }
    const output = observe(liveStateLabel)

    expect(output).toEqual({ observed: false, observedText: liveStateLabel })
    expect(observe("$25 | You're leading | 24 bids")).toEqual({
      observed: true,
      observedText: "$25 | You're leading | 24 bids",
    })

    const load = {
      count: 24,
      durationMs: 1,
      mutations: Array.from({ length: 24 }, (_, index) => ({
        awayPoints: 2,
        bidAmount: index + 2,
        bidderId: '11111111-1111-4111-8111-111111111111',
        homePoints: 1,
        matchupId: '22222222-2222-4222-8222-222222222222',
        nominationId: '33333333-3333-4333-8333-333333333333',
      })),
      visibleUpdate: {
        kind: 'auction-bid',
        entityId: '33333333-3333-4333-8333-333333333333',
        bidAmount: 25,
        bidderId: '11111111-1111-4111-8111-111111111111',
        leaderText: "You're leading",
        observed: output.observed,
        observedText: output.observedText,
      },
    }
    expect(validateBrowserMutationLoad('draft', load)).toEqual(expect.arrayContaining([
      'draft visible update was not observed',
      'draft visible update text does not match the final mutation',
    ]))
  })

  it('rejects skeletal complete data-latency PASS evidence', async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'tests/e2e/performance-budgets.json'), 'utf8'))
    const skeletal = {
      status: 'PASS',
      schemaVersion: '20260710140000',
      repositorySchemaVersion: '20260710140000',
      budgets: {
        dataRequestMs: manifest.globalBudgets.maxDbQueryMs,
        workflowTotalMs: manifest.globalBudgets.fullWorkflowMs,
      },
      workflows: manifest.workflows.map((workflow: { id: string }) => ({ id: workflow.id, status: 'PASS' })),
    }
    const failures = validateDataLatencyReport(manifest, skeletal, true)
    expect(failures).toEqual(expect.arrayContaining([
      'home-live-lineup: data latency total must be a finite nonnegative number',
      'home-live-lineup: data latency steps do not match the canonical ordered contract',
      'home-live-lineup: data latency steps are missing',
    ]))
  })

  it('rejects nonnumeric and reordered complete data-latency steps', () => {
    const workflow = { id: 'dynasty-hub' as const }
    const manifest = {
      workflows: [workflow],
      globalBudgets: { maxDbQueryMs: 100, fullWorkflowMs: 1000 },
    }
    const steps = DATA_LATENCY_STEP_KEYS[workflow.id].map((key) => ({
      workflowId: workflow.id,
      key,
      label: key,
      samples: 3,
      medianMs: 1,
      maxMs: 1,
      rowCount: 0,
      status: 'PASS',
    }))
    const report = {
      status: 'PASS',
      schemaVersion: '1',
      repositorySchemaVersion: '1',
      budgets: { dataRequestMs: 100, workflowTotalMs: 1000 },
      workflows: [{ id: workflow.id, status: 'PASS', totalMedianMs: 3, steps }],
    }
    expect(validateDataLatencyReport(manifest, report, true)).toEqual([])

    const failures = validateDataLatencyReport(manifest, {
      ...report,
      workflows: [{
        ...report.workflows[0],
        totalMedianMs: Number.NaN,
        steps: [{ ...steps[2], medianMs: Number.NaN }, steps[1], steps[0]],
      }],
    }, true)
    expect(failures).toEqual(expect.arrayContaining([
      'dynasty-hub: data latency total must be a finite nonnegative number',
      'dynasty-hub: data latency steps do not match the canonical ordered contract',
      'dynasty-hub: data step roster-news-scope median must be a finite nonnegative number',
    ]))
  })

  it('binds executable data-latency steps to explicit canonical keys before execution', async () => {
    const workflowId = 'dynasty-hub'
    let executions = 0
    const definition = (key: string) => Object.assign(async () => {
      executions += 1
      return {
        workflowId,
        label: key,
        samples: 3,
        medianMs: 1,
        maxMs: 1,
        rowCount: 0,
        status: 'PASS',
      }
    }, { key, label: key })
    const canonical = DATA_LATENCY_STEP_KEYS[workflowId].map(definition)

    await expect(runDataLatencyWorkflow(workflowId, canonical)).resolves.toMatchObject({
      id: workflowId,
      status: 'PASS',
      totalMedianMs: 3,
    })
    expect(executions).toBe(3)

    for (const malformed of [
      [canonical[2], canonical[1], canonical[0]],
      [canonical[0], canonical[0], canonical[2]],
      [canonical[0], canonical[1], definition('search-page')],
    ]) {
      executions = 0
      await expect(runDataLatencyWorkflow(workflowId, malformed)).rejects.toThrow(
        'executable step keys do not match the canonical data latency contract',
      )
      expect(executions).toBe(0)
    }
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
    }, 'report.json')).toContain('workflow: report.json is missing explicit warm request evidence')

    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{
        id: 'workflow', feedbackMs: 1, warmCachedRequestMs: 2, warmRequestCount: 1,
        warmRequestEvidence: 'fetch-or-xhr-duration', coldFullLoadMs: 3,
        feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
      }],
    }, 'report.json')).toContain('workflow: report.json is missing route JS transfer or cache-hit evidence')

    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{
        id: 'workflow', feedbackMs: 1, warmCachedRequestMs: null, warmRequestCount: 0,
        warmRequestEvidence: 'no-fetch-or-xhr-observed', coldFullLoadMs: 3,
        feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
        routeJsCacheHit: true, routeJsEntryCount: 1, routeJsNetworkEntryCount: 0,
        routeJsDecodedKb: 42, routeJsEncodedKb: 42,
        routeJsLedger: [{ url: 'https://app.test/route.js', encodedBodySize: 43008, decodedBodySize: 43008 }],
      }],
    }, 'report.json')).toEqual([])
  })

  it('accepts a ready route served entirely by the shared bundle, and only when it was ready', () => {
    const manifest = {
      globalBudgets: { maxInitialWebJsKb: 350, maxRouteWebJsKb: 220 },
      workflows: [{
        id: 'workflow',
        budgets: { feedbackMs: 100, cachedRequestMs: 300, fullLoadMs: 1000 },
        measurement: { report: 'report.json' },
      }],
    }
    const measurement = {
      id: 'workflow', feedbackMs: 1, warmCachedRequestMs: 2, warmRequestCount: 1,
      warmRequestEvidence: 'fetch-or-xhr-duration', coldFullLoadMs: 3, readyState: true,
      feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 0,
      routeJsCacheHit: false, routeJsEntryCount: 0, routeJsNetworkEntryCount: 0,
      routeJsDecodedKb: 0, routeJsEncodedKb: 0, routeJsLedger: [],
    }
    expect(validateWorkflowReportKeys(manifest, { status: 'PASS', workflowMeasurements: [measurement] }, 'report.json')).toEqual([])
    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS', workflowMeasurements: [{ ...measurement, readyState: false }],
    }, 'report.json')).toContain('workflow: report.json is missing route JS transfer or cache-hit evidence')
  })

  it('rejects missing, nonnumeric, and negative workflow timing evidence', () => {
    const manifest = {
      globalBudgets: { maxInitialWebJsKb: 350, maxRouteWebJsKb: 220 },
      workflows: [{
        id: 'workflow',
        budgets: { feedbackMs: 100, cachedRequestMs: 300, fullLoadMs: 1000 },
        measurement: { report: 'report.json' },
      }],
    }
    const measurement = {
      id: 'workflow', feedbackMs: 1, warmCachedRequestMs: 2, warmRequestCount: 1,
      warmRequestEvidence: 'fetch-or-xhr-duration', coldFullLoadMs: 3,
      feedbackObserved: true, feedbackInteraction: 'real-action', routeWebJsKb: 1,
      routeJsCacheHit: false, routeJsEntryCount: 1, routeJsNetworkEntryCount: 1,
      routeJsDecodedKb: 2, routeJsEncodedKb: 1,
      routeJsLedger: [{ url: 'https://app.test/route.js', encodedBodySize: 1024, decodedBodySize: 2048 }],
    }
    const cases = [
      ['feedbackMs', 'workflow: report.json feedback must be a finite nonnegative number'],
      ['coldFullLoadMs', 'workflow: report.json cold full load must be a finite nonnegative number'],
      ['warmCachedRequestMs', 'workflow: report.json warmed cached request must be a finite nonnegative number'],
    ] as const

    for (const [field, failure] of cases) {
      for (const value of [undefined, Number.NaN, -1]) {
        expect(validateWorkflowReportKeys(manifest, {
          status: 'PASS',
          workflowMeasurements: [{ ...measurement, [field]: value }],
        }, 'report.json')).toContain(failure)
      }
      expect(validateWorkflowReportKeys(manifest, {
        status: 'PASS',
        workflowMeasurements: [{ ...measurement, [field]: 0 }],
      }, 'report.json')).toEqual([])
    }
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
        id: 'workflow', feedbackMs: 1, warmCachedRequestMs: 2, warmRequestCount: 1,
        warmRequestEvidence: 'fetch-or-xhr-duration', coldFullLoadMs: 3,
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
      workflowMeasurements: [{ ...measuredRoute, warmCachedRequestMs: 2, warmRequestCount: 1, warmRequestEvidence: 'fetch-or-xhr-duration', coldFullLoadMs: 1500 }],
    }, 'report.json')).toContain('workflow: report.json cold full load 1500ms exceeds 1000ms')
    expect(validateWorkflowReportKeys(manifest, {
      status: 'PASS',
      workflowMeasurements: [{ ...measuredRoute, warmCachedRequestMs: 400, warmRequestCount: 1, warmRequestEvidence: 'fetch-or-xhr-duration', coldFullLoadMs: 3 }],
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

  it('accepts a route-open timeout only after the requested page has settled', async () => {
    const smokeModule = await import('./e2e/browser-smoke.mjs')
    const openSurfaceRoute = Reflect.get(smokeModule, 'openSurfaceRoute')
    expect(openSurfaceRoute).toBeTypeOf('function')

    const calls: string[][] = []
    await openSurfaceRoute({
      browserCall: async (_session: string, args: string[]) => {
        calls.push(args)
        if (args[0] === 'open') throw new Error('operation timed out')
        return ''
      },
      isSettled: async () => true,
      session: 'route-recovery',
      frontendUrl: 'http://127.0.0.1:8081',
      label: 'league',
      route: '/league',
      phase: 'online',
    })

    expect(calls.filter(([command]) => command === 'open')).toHaveLength(1)
    expect(calls).toContainEqual(['wait', '500'])
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
    const manifest = { globalBudgets: { minHeartbeatSamples: 10 }, workflows: [] }
    const reports = [
      { scenario: 'smoke', season: 1, status: 'PASS', result: { status: 'PASS', workflowMeasurements: [] } },
      { scenario: 'performance', season: 1, status: 'PASS', result: {
        status: 'PASS',
        draftPerf: { ticks: 10, maxLagMs: 0, maxLongTaskMs: 0, longTaskSupported: true },
        homePerf: { ticks: 10, maxLagMs: 0, maxLongTaskMs: 0, longTaskSupported: true },
        load: {
          durationMs: 1,
          draft: { count: 1, durationMs: 1, mutations: [{
            awayPoints: 2,
            bidAmount: 1,
            bidderId: '11111111-1111-4111-8111-111111111111',
            homePoints: 1,
            matchupId: '22222222-2222-4222-8222-222222222222',
            nominationId: '33333333-3333-4333-8333-333333333333',
          }], visibleUpdate: {
            kind: 'auction-bid', entityId: '33333333-3333-4333-8333-333333333333',
            bidAmount: 1, bidderId: '11111111-1111-4111-8111-111111111111',
            leaderText: "You're leading", observed: true,
            observedText: '$1 | You\'re leading | 1 bid',
          } },
          home: { count: 1, durationMs: 1, mutations: [{
            awayPoints: 2,
            bidAmount: null,
            bidderId: null,
            homePoints: 1,
            matchupId: '22222222-2222-4222-8222-222222222222',
            nominationId: null,
          }], visibleUpdate: {
            kind: 'matchup-score', entityId: '22222222-2222-4222-8222-222222222222',
            homePoints: 1, awayPoints: 2, observed: true, observedText: '1.0 vs 2.0',
          } },
        },
        workflowMeasurements: [],
      } },
    ]
    expect(validateRetainedSeasonReports(manifest, reports, 1)).toEqual([])
    const undersampled = structuredClone(reports)
    undersampled[1]!.result.draftPerf!.ticks = 1
    undersampled[1]!.result.homePerf!.ticks = 1
    expect(validateRetainedSeasonReports(manifest, undersampled, 1)).toEqual(expect.arrayContaining([
      'season 1: draft heartbeat ticks 1 are below minimum 10',
      'season 1: home heartbeat ticks 1 are below minimum 10',
    ]))
    expect(validateRetainedSeasonReports(manifest, reports, 2)).toContain('season 2: retained smoke report is missing')
  })
})
