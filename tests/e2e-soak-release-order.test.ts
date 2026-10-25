import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planSoakShards } from './e2e/soak-shards.mjs'
import { preparedMigrationFailures, soakBrowserArgs, soakRuntimeForShard, soakRuntimeSchemaFailures } from './e2e/soak-runtime.mjs'
import { BROWSER_SCENARIO_MANIFEST } from './e2e/browser-scenario-manifest.mjs'
import { REQUIRED_MUTATION_SCENARIOS } from './e2e/release-mutation-compatibility.mjs'
import { validateRetainedSeasonReports } from './e2e/performance-budgets.mjs'
import { validatePerfDrift } from './e2e/soak-support.mjs'

describe('release soak deployment order', () => {
  it('checks schema and selects the deployed runtime before serving either build', () => {
    const workflow = readFileSync('.github/workflows/release-soak-shard.yml', 'utf8')
    const start = workflow.split('      - name: Start release stack\n')[1].split('\n      - ')[0]
    const prepare = start.indexOf('node tests/e2e/soak-runtime.mjs --prepare')
    expect(prepare).toBeGreaterThan(-1)
    expect(prepare).toBeLessThan(start.indexOf('supabase functions serve'))
    expect(prepare).toBeLessThan(start.indexOf('node tests/e2e/static-web-server.mjs'))
    expect(start).toContain('if test "$E2E_SOAK_RUNTIME" = release; then')
    expect(start).toContain('cd "$deployed_edge_worktree"')
    expect(start).toContain('web_root="$deployed_frontend_worktree/dist"')
    expect(start).toContain('expected_edge_sha="$E2E_DEPLOYED_EDGE_SHA"')
    expect(start).toContain('supabase start --exclude edge-runtime')
    const branches = start.split('          if test "$E2E_SOAK_RUNTIME" = release; then')[1].split('          fi')[0]
    expect(branches.split('          else')[0]).toContain('web_root=dist')
    expect(branches.split('          else')[1]).toContain('web_root="$deployed_frontend_worktree/dist"')
    const plan = readFileSync('.github/workflows/release-soak.yml', 'utf8')
    expect(plan.match(/migration_after_season: 5/g)).toHaveLength(4)
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
    const args = Object.fromEntries(BROWSER_SCENARIO_MANIFEST.map(({ flag }) => [flag, true]))
    const deployed = soakBrowserArgs(args, 5, 5)
    expect(BROWSER_SCENARIO_MANIFEST.filter(({ flag }) => deployed[flag]).map(({ id }) => id).sort())
      .toEqual([...REQUIRED_MUTATION_SCENARIOS].sort())
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
