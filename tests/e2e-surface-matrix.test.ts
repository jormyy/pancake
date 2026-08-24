import { describe, expect, it } from 'vitest'

import {
  REQUIRED_FULL_SWEEP_LABELS,
  routeEvidenceFailures,
  workerUpdateFailures,
} from './e2e/browser-smoke.mjs'
import { browserEvidenceIds } from './e2e/browser-scenario-manifest.mjs'
import {
  CONFIGURED_SOURCE_SUITES,
  sourceRecoveryFailures,
} from './e2e/source-failure-recovery.mjs'
import {
  readSurfaceMatrix,
  repositoryRouteSources,
  surfaceSoakCoverageFailures,
  validateSurfaceMatrix,
} from './e2e/surface-matrix.mjs'

const allFunctionEvidence = (matrix: Awaited<ReturnType<typeof readSurfaceMatrix>>) => [
  ...new Set(matrix.functions.flatMap((item: {
    happyPathEvidenceIds: string[]
    failurePaths: { evidenceIds: string[] }[]
    recoveryPaths: { evidenceIds: string[] }[]
  }) => [
    ...item.happyPathEvidenceIds,
    ...item.failurePaths.flatMap((path) => path.evidenceIds),
    ...item.recoveryPaths.flatMap((path) => path.evidenceIds),
  ])),
]

describe('expanded surface matrix', () => {
  it('maps every repository route to the full browser sweep', async () => {
    const [matrix, routes] = await Promise.all([readSurfaceMatrix(), repositoryRouteSources()])

    expect(validateSurfaceMatrix(matrix, routes)).toEqual([])
    expect([...matrix.surfaces.map(({ routeLabel }: { routeLabel: string }) => routeLabel)].sort())
      .toEqual([...REQUIRED_FULL_SWEEP_LABELS].sort())
  })

  it('fails when a repository route is missing', async () => {
    const [matrix, routes] = await Promise.all([readSurfaceMatrix(), repositoryRouteSources()])
    const mutated = structuredClone(matrix)
    mutated.surfaces = mutated.surfaces.slice(1)

    expect(validateSurfaceMatrix(mutated, routes).some((failure) =>
      failure.startsWith('unmapped route sources:'),
    )).toBe(true)
  })

  it('fails when a contract dimension or proof is missing', async () => {
    const [matrix, routes] = await Promise.all([readSurfaceMatrix(), repositoryRouteSources()])
    const missingDimension = structuredClone(matrix)
    delete missingDimension.surfaces[0].contracts.freshness
    const unknownProof = structuredClone(matrix)
    unknownProof.surfaces[0].contracts.cache.proofIds = ['unknown.proof']

    expect(validateSurfaceMatrix(missingDimension, routes)).toContain(
      `${matrix.surfaces[0].id}.freshness has no explicit mode`,
    )
    expect(validateSurfaceMatrix(unknownProof, routes)).toContain(
      `${matrix.surfaces[0].id}.cache uses unknown evidence id unknown.proof`,
    )
  })

  it('fails duplicate data and function identifiers', async () => {
    const [matrix, routes] = await Promise.all([readSurfaceMatrix(), repositoryRouteSources()])
    const duplicateData = structuredClone(matrix)
    duplicateData.dataClasses.push(structuredClone(duplicateData.dataClasses[0]))
    const duplicateFunction = structuredClone(matrix)
    duplicateFunction.functions.push(structuredClone(duplicateFunction.functions[0]))

    expect(validateSurfaceMatrix(duplicateData, routes)).toContain(
      `duplicate data class id ${matrix.dataClasses[0].id}`,
    )
    expect(validateSurfaceMatrix(duplicateFunction, routes)).toContain(
      `duplicate function id ${matrix.functions[0].id}`,
    )
  })

  it('requires passing soak evidence for every mapped path', async () => {
    const matrix = await readSurfaceMatrix()
    const evidenceIds = allFunctionEvidence(matrix)

    expect(surfaceSoakCoverageFailures(matrix, [])).not.toEqual([])
    expect(surfaceSoakCoverageFailures(matrix, [{
      season: 1,
      status: 'FAIL',
      evidenceIds,
    }])).not.toEqual([])
    expect(surfaceSoakCoverageFailures(matrix, [{
      season: 1,
      status: 'PASS',
      evidenceIds,
    }])).toEqual([])
  })

  it('requires route-level online, offline, and reconnect observations', () => {
    const observations = (phase: 'online' | 'offline' | 'reconnect') =>
      REQUIRED_FULL_SWEEP_LABELS.map((label) => ({
        label,
        phase,
        onLine: phase !== 'offline',
        networkProbeReached: phase !== 'offline',
        serviceWorkerReady: true,
        serviceWorkerControlled: true,
        bodyTextLength: 40,
        horizontalOverflowPx: 0,
        apiCacheEntries: Array<string>(),
        cacheNames: ['pancake-release-shell'],
        navigation: { responseEndMs: 5 },
      }))
    const evidence = {
      online: observations('online'),
      offline: observations('offline'),
      reconnect: observations('reconnect'),
    }

    expect(routeEvidenceFailures(evidence)).toEqual([])
    evidence.offline.pop()
    expect(routeEvidenceFailures(evidence)).toContain(
      `offline is missing ${REQUIRED_FULL_SWEEP_LABELS.at(-1)}`,
    )
    evidence.online[0].apiCacheEntries.push('https://example.test/rest/v1/players')
    expect(routeEvidenceFailures(evidence)).toContain(
      `online.${REQUIRED_FULL_SWEEP_LABELS[0]} cached API or realtime URLs`,
    )
  })

  it('requires worker takeover, cleanup, reload, and restoration', () => {
    const proof = {
      testVersion: 'pancake-next',
      oldCachesDeleted: true,
      newShellCache: 'pancake-next-shell',
      workerWaitingAfterUpdate: false,
      controllerChanged: true,
      pageNavigationType: 'reload',
      pageReloaded: true,
      restoredOriginalWorker: true,
    }

    expect(workerUpdateFailures(proof)).toEqual([])
    expect(workerUpdateFailures({ ...proof, controllerChanged: false })).toContain(
      'controller did not change',
    )
    expect(workerUpdateFailures({ ...proof, pageReloaded: false })).toContain(
      'controller change did not load a new page document',
    )
  })

  it('accepts nested browser evidence only from passing scenarios', () => {
    const evidenceIds = ['browser.surface_online', 'browser.surface_offline']

    expect(browserEvidenceIds({ browserCheck: { status: 'PASS', evidenceIds } }))
      .toEqual(['browser.smoke', ...evidenceIds])
    expect(browserEvidenceIds({ browserCheck: { status: 'FAIL', evidenceIds } })).toEqual([])
  })

  it('requires every configured source recovery contract', () => {
    const report = {
      sources: CONFIGURED_SOURCE_SUITES.map((source) => source.disabledReason
        ? { id: source.id, status: 'DISABLED', disabledReason: source.disabledReason }
        : { id: source.id, status: 'PASS' }),
    }

    expect(sourceRecoveryFailures(report)).toEqual([])
    report.sources[0].status = 'FAIL'
    expect(sourceRecoveryFailures(report)).toContain('configured source nba-cdn recovery did not pass')
  })
})
