import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planSoakShards } from './e2e/soak-shards.mjs'
import { preparedMigrationFailures, soakBrowserArgs, soakRuntimeForShard, soakRuntimeSchemaFailures } from './e2e/soak-runtime.mjs'
import { BACKEND_SCENARIO_MANIFEST } from './e2e/backend-scenario-manifest.mjs'
import { BROWSER_SCENARIO_MANIFEST } from './e2e/browser-scenario-manifest.mjs'
import { REQUIRED_MUTATION_SCENARIOS } from './e2e/release-mutation-compatibility.mjs'
import { validateRetainedSeasonReports } from './e2e/performance-budgets.mjs'
import { validatePerfDrift } from './e2e/soak-support.mjs'

describe('release soak deployment order', () => {

  it('accepts startup only when the served frontend marker and Edge health match', () => {
    const workflow = readFileSync('.github/workflows/release-soak-shard.yml', 'utf8')
    const loop = workflow.split('frontend="$(curl --fail --silent http://127.0.0.1:8082/release-provenance.json')[1]
    expect(loop).toBeTruthy()
    const script = loop.split("node -e '")[1].split("' \"$health\"")[0]
    const edge = JSON.stringify({ commitSha: 'edge', edgeArtifactDigest: 'edge-digest' })
    const frontend = { commitSha: 'frontend', bundleDigest: 'frontend-digest' }
    const run = (observed: string) => spawnSync(process.execPath, ['-e', script, edge, 'edge', 'edge-digest',
      observed, 'frontend', 'frontend-digest']).status
    expect(run(JSON.stringify(frontend))).toBe(0)
    expect(run(JSON.stringify({ ...frontend, commitSha: 'candidate' }))).toBe(1)
    expect(run(JSON.stringify({ ...frontend, bundleDigest: 'wrong' }))).toBe(1)
    expect(run('not-json')).not.toBe(0)
  })

  it('rejects release Edge and frontend on the deployed schema in every later shard', () => {
    const shards = planSoakShards(20, 4)
    expect(shards.map((shard) => soakRuntimeForShard(shard, 5))).toEqual(['deployed', 'release', 'release', 'release'])
    for (const shard of shards) {
      const runtime = soakRuntimeForShard(shard, 5)
      const base = { runtime, deployedVersion: '100', repositoryHead: '200' }
      expect(soakRuntimeSchemaFailures({ ...base, appliedVersion: runtime === 'deployed' ? '100' : '200' })).toEqual([])
      expect(soakRuntimeSchemaFailures({ ...base, appliedVersion: runtime === 'deployed' ? '200' : '100' })).not.toEqual([])
    }
    expect(() => soakRuntimeForShard(shards[0], 4)).toThrow('migration boundary')
  })

  it('runs the deployed compatibility set before migration and every release scenario afterward', () => {
    const args = { ...Object.fromEntries([...BROWSER_SCENARIO_MANIFEST, ...BACKEND_SCENARIO_MANIFEST].map(({ flag }) => [flag, true])), push: true }
    const deployed = soakBrowserArgs(args, 5, 5)
    expect(BROWSER_SCENARIO_MANIFEST.filter(({ flag }) => deployed[flag]).map(({ id }) => id).sort())
      .toEqual([...REQUIRED_MUTATION_SCENARIOS].sort())
    expect(BACKEND_SCENARIO_MANIFEST.filter(({ flag }) => deployed[flag]).map(({ id }) => id).sort())
      .toEqual(BACKEND_SCENARIO_MANIFEST.filter(({ id }) => REQUIRED_MUTATION_SCENARIOS.includes(id)).map(({ id }) => id).sort())
    expect(deployed.push).toBe(false)
    expect(soakBrowserArgs(args, 6, 5)).toBe(args)
  })

  it('requires the exact migration delta when the soak reads prepared evidence', () => {
    const plan = { deployedVersion: '100', repositoryHead: '200', pendingVersions: ['150', '200'] }
    const report = { expectedBaseVersion: '100', expectedVersion: '200', expectedVersions: ['150', '200'],
      beforeVersions: ['050', '100'], afterVersions: ['050', '100', '150', '200'], status: 'APPLIED' }
    expect(preparedMigrationFailures(report, plan)).toEqual([])
    for (const changed of [
      { status: 'ERROR' }, { expectedBaseVersion: '050' }, { expectedVersion: '150' },
      { expectedVersions: ['200'] }, { afterVersions: ['050', '100', '200'] },
      { beforeVersions: ['050', '150'] },
    ]) expect(preparedMigrationFailures({ ...report, ...changed }, plan).length).toBeGreaterThan(0)
  })

  it('requires every deployed mutation report while retaining release performance gates', () => {
    const reports = REQUIRED_MUTATION_SCENARIOS.map((scenario) => ({ scenario, season: 1, status: 'PASS', result: { status: 'PASS' } }))
    expect(validateRetainedSeasonReports({}, reports, 1, undefined, 1)).toEqual([])
    expect(validateRetainedSeasonReports({}, reports.slice(1), 1, undefined, 1))
      .toContain('season 1: retained deployed league-lifecycle report is missing or failed')
    expect(validateRetainedSeasonReports({}, reports, 2, undefined, 1)).toEqual([
      'season 2: retained smoke report is missing', 'season 2: retained performance report is missing',
    ])
  })

  it('attributes deployed reports to the deployed frontend and rejects candidate evidence', () => {
    const candidate = { commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64), runId: 'run' }
    const deployed = { commitSha: 'c'.repeat(40), bundleDigest: 'd'.repeat(64), runId: 'run' }
    const reports = REQUIRED_MUTATION_SCENARIOS.map(scenario => ({ scenario, season: 1, status: 'PASS',
      result: { status: 'PASS' }, provenance: deployed }))
    expect(Reflect.apply(validateRetainedSeasonReports, null, [{}, reports, 1, candidate, 1, deployed])).toEqual([])
    reports[0].provenance = candidate
    expect(Reflect.apply(validateRetainedSeasonReports, null, [{}, reports, 1, candidate, 1, deployed]))
      .toEqual(expect.arrayContaining([expect.stringContaining('provenance commitSha'), expect.stringContaining('provenance bundleDigest')]))
  })

  it('compares full season times within one runtime build and still detects growth', () => {
    const metrics = Array.from({ length: 15 }, (_, index) => ({
      season: index + 1, runtime: index < 5 ? 'deployed' : 'release', durationMs: index < 5 ? 100 : 200,
    }))
    expect(validatePerfDrift(metrics, 20)).toEqual([])
    for (const row of metrics.slice(-3)) row.durationMs = 300
    expect(validatePerfDrift(metrics, 20)).toEqual([
      'D.LONG.6: per-season runtime median drifted 50% from seasons 6-8 (200ms) to seasons 13-15 (300ms); limit is 20%',
    ])
  })
})
