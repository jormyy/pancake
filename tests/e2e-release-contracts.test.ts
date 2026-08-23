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

describe('release E2E contracts', () => {
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

  it('clears Metro transforms before stamping a release bundle', async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'))
    expect(packageJson.scripts['build:web:release']).toBe(
      'expo export --platform web --clear && node scripts/stamp-release-provenance.mjs',
    )
    const vercel = JSON.parse(await readFile(path.join(process.cwd(), 'vercel.json'), 'utf8'))
    expect(vercel.installCommand).toBe('npm ci')
    expect(vercel.buildCommand).toBe('npm run build:web:release')
    // Production deploys from main were turned on deliberately (#45); this
    // assertion still pins the flag so the change stays a decision, not a drift.
    expect(vercel.git.deploymentEnabled.main).toBe(true)
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

    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/release-soak.yml'), 'utf8')
    expect(workflow).toContain('E2E_DEPLOYED_SCHEMA_VERSION')
    expect(workflow).toContain('release-soak-migration-plan.mjs')
    expect(workflow).toContain('E2E_MIDLIFE_EXPECTED_VERSIONS')
    expect(workflow).toContain('Verify cross-version runtime compatibility against upgraded schema')
    expect(workflow).toContain('release-runtime-compatibility.mjs')
    expect(workflow).toContain('select version::text, name::text')
    expect(workflow).toContain('--history-file /tmp/deployed-schema-history.json')
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
      '.github/workflows/production-deploy.yml',
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
    expect(workflow).toContain('release_sha:')
    expect(workflow).toContain('frontend_sha:')
    expect(workflow).toContain('edge_sha:')
    expect(workflow).toContain('frontend_bundle_digest:')
    expect(workflow).toContain('edge_artifact_digest:')
    expect(workflow).toContain('repository_dispatch:')
    expect(workflow).toContain('types: [production_deployed]')
    expect(workflow).toContain("github.event_name == 'repository_dispatch' && github.event.client_payload.release_sha || inputs.release_sha")
    expect(workflow).toContain("github.event_name == 'repository_dispatch' && github.event.client_payload.frontend_bundle_digest || inputs.frontend_bundle_digest")
    expect(workflow).toContain("github.event_name == 'repository_dispatch' && github.event.client_payload.edge_artifact_digest || inputs.edge_artifact_digest")
    expect(workflow).toContain('E2E_FRONTEND_URL: ${{ inputs.frontend_url || secrets.PANCAKE_FRONTEND_URL }}')
    expect(workflow).toContain('E2E_EXPECTED_FRONTEND_HOST: ${{ secrets.PANCAKE_PRODUCTION_FRONTEND_HOST }}')
    expect(workflow).toContain('EXPO_PUBLIC_SUPABASE_URL: ${{ secrets.SUPABASE_URL }}')
    expect(workflow).toContain('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ${{ secrets.SUPABASE_PUBLISHABLE_KEY }}')
    expect(workflow).toContain('node tests/e2e/hosted-release-provenance.mjs')
    expect(workflow).toContain('node scripts/stamp-edge-release-provenance.mjs')
    expect(workflow).toContain('npm run e2e:web-hydration')
    expect(workflow).toContain('PANCAKE_LEGACY_SUPABASE_JWT_ROTATED: ${{ secrets.PANCAKE_LEGACY_SUPABASE_JWT_ROTATED }}')
    expect(workflow).not.toContain("PANCAKE_LEGACY_SUPABASE_JWT_ROTATED: '1'")
    for (const command of [
      'npm run prod:check',
      'npm run prod:data-health -- --linked --allow-prod-writes',
      'npm run security:edge-auth:linked -- --positive',
      'npm run security:db-catalog -- --linked',
    ]) expect(workflow).toContain(command)
    expect(workflow).toContain('if-no-files-found: error')
    expect(workflow).toContain("inputs.evidence_label || 'production'")
  })

  it('promotes only after every phased production pairing passes protected readiness', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/production-deploy.yml'), 'utf8')
    expect(workflow).toContain('npx --yes vercel@55.0.0 build')
    expect(workflow).toContain('node tests/e2e/validate-production-target.mjs')
    expect(workflow).toContain('supabase db push --linked --yes')
    expect(workflow).toContain('supabase functions deploy --project-ref "$SUPABASE_PROJECT_REF"')
    expect(workflow).toContain('Bake candidate Edge artifact provenance')
    expect(workflow).not.toContain('PANCAKE_RELEASE_BUNDLE_DIGEST=')
    const candidateCurrent = workflow.indexOf('Verify candidate frontend with current backend')
    const migrate = workflow.indexOf('Apply compatibility-proven database phase')
    const currentAfterMigration = workflow.indexOf('Verify current release after database phase')
    const deployEdge = workflow.indexOf('Deploy candidate Edge phase')
    const currentNewEdge = workflow.indexOf('Verify current frontend with new Edge')
    const candidateNewEdge = workflow.indexOf('Verify candidate frontend with new Edge')
    const promote = workflow.indexOf('Promote verified candidate')
    expect(candidateCurrent).toBeGreaterThan(-1)
    expect(candidateCurrent).toBeLessThan(migrate)
    expect(migrate).toBeLessThan(currentAfterMigration)
    expect(currentAfterMigration).toBeLessThan(deployEdge)
    expect(deployEdge).toBeLessThan(currentNewEdge)
    expect(deployEdge).toBeLessThan(candidateNewEdge)
    expect(currentNewEdge).toBeLessThan(promote)
    expect(candidateNewEdge).toBeLessThan(promote)
    expect(workflow).toContain('uses: ./.github/workflows/production-readiness.yml')
    expect(workflow).toContain('Restore baseline Edge after failed Edge phase')
    expect(workflow).toContain("needs.deploy-edge.result == 'failure'")
    expect(workflow).toContain("needs.deploy-edge.result == 'cancelled'")
    for (const label of [
      'candidate-current-backend',
      'current-after-migration',
      'current-new-edge',
      'candidate-new-edge',
      'promoted-production',
    ]) expect(workflow).toContain(`evidence_label: ${label}`)
    expect(workflow).toContain('npx --yes vercel@55.0.0 promote')
    expect(workflow).toContain('Verify promoted production')
    expect(workflow).toContain('Restore baseline release after failed promotion')
    expect(workflow).toContain("needs.promote.result == 'failure'")
    expect(workflow).toContain("needs.promote.result == 'cancelled'")
    expect(workflow).toContain("needs.promote.result == 'success' && needs.verify-production.result != 'success'")
    expect(workflow).toContain("needs.verify-production.result != 'success'")
    expect(workflow).toContain('Restore and attest baseline frontend')
    expect(workflow).toContain('Restore baseline Edge')
    expect(workflow).toContain('Verify restored immutable release')
    expect(workflow).toContain('evidence_label: post-promotion-rollback')
    expect(workflow).toContain('Require deployed-to-HEAD release soak')
    expect(workflow).toContain('needs: release-soak')
  })

  it('stamps a self-consistent marker and build-specific cache version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-release-bundle-'))
    tempDirs.push(root)
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'app.js'), 'console.log("release")\n')
    await writeFile(path.join(root, 'dist', 'sw.js'), "const VERSION = 'pancake-dev'\n")
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
    })
    expect(await digestReleaseBundle(root)).toBe(marker.bundleDigest)
    expect(JSON.parse(await readFile(path.join(root, 'dist', 'release-provenance.json'), 'utf8'))).toEqual(marker)

    const firstWorker = await readFile(path.join(root, 'dist', 'sw.js'), 'utf8')
    expect(firstWorker).toMatch(/pancake-aaaaaaaaaaaa-[a-f0-9]{12}/)
    await writeFile(path.join(root, 'dist', 'app.js'), 'console.log("rebuilt release")\n')
    await writeFile(path.join(root, 'dist', 'sw.js'), "const VERSION = 'pancake-dev'\n")
    const rebuiltMarker = await stampReleaseProvenance({ root, commitSha: 'a'.repeat(40) })
    const rebuiltWorker = await readFile(path.join(root, 'dist', 'sw.js'), 'utf8')
    expect(rebuiltWorker).not.toBe(firstWorker)
    expect(await digestReleaseBundle(root)).toBe(rebuiltMarker.bundleDigest)

    await writeFile(path.join(root, 'vercel.json'), '{"rewrites":[]}\n')
    const routingDigest = await digestReleaseBundle(root)
    expect(routingDigest).not.toBe(rebuiltMarker.bundleDigest)
    await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
    expect(await digestReleaseBundle(root)).not.toBe(routingDigest)
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
      deployedFrontendRebuild: {
        exactProductionRebuildVerified: true,
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
      deployedFrontendRebuild: { ...input.deployedFrontendRebuild, exactProductionRebuildVerified: false },
    })).toContain('deployed frontend exact production rebuild was not verified')

    const soakWorkflow = await readFile(path.join(process.cwd(), '.github/workflows/release-soak.yml'), 'utf8')
    expect(soakWorkflow).toContain('test "$marker_digest" = "$E2E_DEPLOYED_FRONTEND_DIGEST"')
    expect(soakWorkflow).toContain('export E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST=')
    expect(soakWorkflow).not.toContain("printf 'E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST=%s")
    expect(soakWorkflow.match(/release-mutation-compatibility\.mjs/g)).toHaveLength(3)
    expect(soakWorkflow).toContain('--pair=deployed-frontend-deployed-edge')
    expect(soakWorkflow).not.toContain('browser-ci-scenario.mjs --scenario=smoke')
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

  it('uses the exact semantic mutation contract in the browser producer', async () => {
    const producer = await readFile(path.join(process.cwd(), 'tests/e2e/browser-perf-smoke.mjs'), 'utf8')
    const livePanel = await readFile(path.join(process.cwd(), 'components/league/draft-room/AuctionLivePanel.tsx'), 'utf8')
    expect(producer).toContain("validateBrowserMutationLoad('draft', draftLoad)")
    expect(producer).toContain("validateBrowserMutationLoad('home', homeLoad)")
    expect(producer).not.toContain("text.includes('$' + expected.amount)")
    expect(livePanel).toContain('testID="auction-live-state" accessibilityLabel={liveStateLabel}')
  })

  it('starts draft load measurement after visual evidence capture', async () => {
    const producer = await readFile(path.join(process.cwd(), 'tests/e2e/browser-perf-smoke.mjs'), 'utf8')
    const draftStart = producer.indexOf("const draftFeedback = await measureWorkflowFeedback")
    const draftEnd = producer.indexOf('const draftLoad = await runLoadMutations', draftStart)
    const setup = producer.slice(draftStart, draftEnd)

    expect(setup).toContain("['screenshot', path.join(artifactDir, 'draft-before-load.png')]")
    expect(setup).toContain('await installHeartbeat(session)')
    expect(setup.indexOf("'draft-before-load.png'")).toBeLessThan(setup.indexOf('await installHeartbeat(session)'))
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

  it('terminates the waiver backlog lock backend and proves cleanup before passing', async () => {
    const source = await readFile(path.join(process.cwd(), 'tests/e2e/waiver-backlog-db.mjs'), 'utf8')
    expect(source).toContain('PGAPPNAME: lockApplicationName')
    expect(source).toContain('SELECT pg_terminate_backend(pid) FROM pg_stat_activity')
    expect(source).toContain("'backends', (SELECT count(*) FROM pg_stat_activity")
    expect(source).toContain("'locks', (SELECT count(*) FROM pg_locks")
    expect(source).toContain('if (leaked)')
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
