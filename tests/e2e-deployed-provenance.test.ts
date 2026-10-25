import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { deployedFrontendProvenance, readDeployedFrontendProvenance } from './e2e/release-provenance.mjs'

it('reads the deployed build marker and rejects a marker from another build', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-deployed-marker-'))
  const markerPath = path.join(directory, 'release-provenance.json')
  const marker = { commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) }
  vi.stubEnv('E2E_DEPLOYED_FRONTEND_SHA', marker.commitSha)
  vi.stubEnv('E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST', marker.bundleDigest)
  vi.stubEnv('E2E_DEPLOYED_FRONTEND_PROVENANCE_PATH', markerPath)
  vi.stubEnv('GITHUB_RUN_ID', 'current-run')
  try {
    await writeFile(markerPath, JSON.stringify(marker))
    await expect(readDeployedFrontendProvenance()).resolves.toEqual({ ...marker, runId: 'current-run' })
    for (const changed of [{ commitSha: 'c'.repeat(40) }, { bundleDigest: 'd'.repeat(64) }]) {
      await writeFile(markerPath, JSON.stringify({ ...marker, ...changed }))
      await expect(readDeployedFrontendProvenance()).rejects.toThrow('does not match')
    }
    vi.stubEnv('E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST', '')
    expect(() => deployedFrontendProvenance()).toThrow('compatibility digest')
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})
