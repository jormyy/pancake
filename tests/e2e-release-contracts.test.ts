import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertFullSweepRoutes, REQUIRED_FULL_SWEEP_LABELS } from './e2e/browser-smoke.mjs'
import { writeRegisteredScenarioReport } from './e2e/browser-scenario-registry.mjs'
import { validateWorkflowReportKeys } from './e2e/performance-budgets.mjs'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('release E2E contracts', () => {
  it('rejects a declared workflow budget when any measurement is absent', () => {
    const manifest = {
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
})
