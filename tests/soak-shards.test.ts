import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeUpstreamServer } from './e2e/fake-upstream.mjs'
import {
  CHECKPOINT_SCHEMA_VERSION,
  checkpointFailures,
  completedSoakFailures,
  planSoakShards,
  resolveSoakShard,
  seasonArtifactFailures,
} from './e2e/soak-shards.mjs'
import { soakShardPlanFailures } from './e2e/soak-shard-plan-check.mjs'

const passRows = (through: number) => Array.from({ length: through }, (_, index) => ({ season: index + 1, status: 'PASS', notes: '' }))
const release = (shard: number) => ({
  releaseSha: 'a'.repeat(40),
  planSha256: 'b'.repeat(64),
  totalSeasons: 20,
  shard: planSoakShards(20, 4)[shard - 1],
  candidate: { frontendDigest: 'c'.repeat(64), edgeDigest: 'd'.repeat(64) },
})
const checkpointFor = (shard: number) => {
  const through = planSoakShards(20, 4)[shard - 1].firstSeason - 1
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    releaseSha: 'a'.repeat(40),
    migrationPlanSha256: 'b'.repeat(64),
    totalSeasons: 20,
    shardCount: 4,
    candidate: { frontendDigest: 'c'.repeat(64), edgeDigest: 'd'.repeat(64) },
    startedAt: '2026-10-05T00:00:00.000Z',
    rows: passRows(through),
    notes: [],
    perfMetrics: Array.from({ length: through }, (_, index) => ({ season: index + 1, durationMs: 1, memory: {} })),
    previousSnapshot: { counts: { roster_players: 10 } },
    scenarios: { historyFixtures: [] },
    fakeUpstream: { players: [], games: [] },
    shards: planSoakShards(20, 4).slice(0, shard - 1).map((done) => ({ ...done, status: 'PASS' })),
  }
}

describe('soak shard plan', () => {
  it('splits every season into contiguous shards exactly once', () => {
    expect(planSoakShards(20, 4).map(({ firstSeason, lastSeason }) => [firstSeason, lastSeason]))
      .toEqual([[1, 5], [6, 10], [11, 15], [16, 20]])
    for (const [seasons, shards] of [[20, 3], [7, 7], [20, 1], [11, 4]]) {
      const plan = planSoakShards(seasons, shards)
      const covered = plan.flatMap(({ firstSeason, lastSeason }) =>
        Array.from({ length: lastSeason - firstSeason + 1 }, (_, index) => firstSeason + index))
      expect(covered).toEqual(Array.from({ length: seasons }, (_, index) => index + 1))
      expect(Math.max(...plan.map(({ firstSeason, lastSeason }) => lastSeason - firstSeason + 1)))
        .toBe(Math.ceil(seasons / shards))
    }
  })

  it('rejects impossible shard plans and malformed shard selections', () => {
    expect(() => planSoakShards(20, 0)).toThrow('between 1 and 20')
    expect(() => planSoakShards(20, 21)).toThrow('between 1 and 20')
    expect(() => planSoakShards(0, 1)).toThrow('positive season count')
    expect(resolveSoakShard('', 20)).toEqual({ shard: 1, shardCount: 1, firstSeason: 1, lastSeason: 20 })
    expect(resolveSoakShard('2/4', 20)).toEqual({ shard: 2, shardCount: 4, firstSeason: 6, lastSeason: 10 })
    expect(() => resolveSoakShard('5/4', 20)).toThrow('outside 1..4')
    expect(() => resolveSoakShard('0/4', 20)).toThrow('outside 1..4')
    expect(() => resolveSoakShard('two', 20)).toThrow('K/N')
  })
})

describe('soak season aggregation', () => {
  it('accepts every season once, in order, passing', () => {
    expect(completedSoakFailures([...passRows(20), { season: 0, status: 'PASS', notes: '' }], 20)).toEqual([])
  })

  it('rejects missing, duplicate, out-of-order and failing seasons', () => {
    const rows = passRows(20)
    expect(completedSoakFailures(rows.filter((row) => row.season !== 7), 20)[0]).toContain('missing 7')
    expect(completedSoakFailures([...rows.slice(0, 10), rows[9], ...rows.slice(10)], 20)[0]).toContain('duplicate 10')
    expect(completedSoakFailures([rows[1], rows[0], ...rows.slice(2)], 20)[0]).toContain('exactly 1..20 in order')
    expect(completedSoakFailures([...rows, { season: 21, status: 'PASS', notes: '' }], 20)[0]).toContain('unexpected 21')
    expect(completedSoakFailures(rows.map((row) => row.season === 12 ? { ...row, status: 'FAIL' } : row), 20))
      .toContain('Soak seasons did not pass: 12')
  })
})

describe('soak shard checkpoint', () => {
  it('resumes only from the matching release, plan, build and previous shards', () => {
    expect(checkpointFailures(null, release(1))).toEqual([])
    expect(checkpointFailures(checkpointFor(2), release(1))).toEqual(['Shard 1 must start without a soak checkpoint'])
    for (const shard of [2, 3, 4]) expect(checkpointFailures(checkpointFor(shard), release(shard))).toEqual([])
    expect(checkpointFailures(null, release(3))).toEqual(['Shard 3 requires the checkpoint from shard 2'])
  })

  it.each([
    ['release', { releaseSha: 'e'.repeat(40) }, 'different release SHA'],
    ['plan', { migrationPlanSha256: 'f'.repeat(64) }, 'different migration plan'],
    ['season count', { totalSeasons: 10 }, 'different season count'],
    ['shard count', { shardCount: 5 }, 'different shard count'],
    ['candidate build', { candidate: { frontendDigest: '0'.repeat(64), edgeDigest: 'd'.repeat(64) } }, 'different candidate build'],
    ['skipped shard', { shards: [{ ...planSoakShards(20, 4)[0], status: 'PASS' }] }, 'passing shards 1..2'],
    ['failed shard', { shards: planSoakShards(20, 4).slice(0, 2).map((done) => ({ ...done, status: 'FAIL' })) }, 'passing shards 1..2'],
    ['missing season', { rows: passRows(10).filter((row) => row.season !== 4) }, 'missing 4'],
    ['duplicate season', { rows: [...passRows(10), { season: 10, status: 'PASS', notes: '' }] }, 'duplicate 10'],
    ['failed season', { rows: passRows(10).map((row) => row.season === 9 ? { ...row, status: 'FAIL' } : row) }, 'did not pass: 9'],
    ['missing perf metric', { perfMetrics: [] }, 'perf metric seasons'],
    ['missing snapshot', { previousSnapshot: null }, 'previous season snapshot'],
    ['missing fake upstream', { fakeUpstream: null }, 'fake upstream state'],
  ])('rejects a checkpoint with a %s', (_label, change, message) => {
    const failures = checkpointFailures({ ...checkpointFor(3), ...change }, release(3))
    expect(failures.join('; ')).toContain(message)
  })
})

describe('soak season artifacts', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  const writeSeason = (season: number, registry: string[]) => {
    for (const file of [
      `tests/artifacts/season-${season}/fake-upstream.json`,
      `tests/artifacts/season-${season}/dynasty-decision-tools.json`,
      `tests/snapshots/season-${season}/summary.json`,
      ...registry.map((scenario) => `tests/artifacts/registry/${scenario}-season-${season}.json`),
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), '{}')
    }
  }

  it('requires each season evidence once and nothing beyond the run', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'pancake-soak-artifacts-'))
    const registry = () => ['smoke', 'performance']
    for (let season = 1; season <= 3; season += 1) writeSeason(season, registry())
    expect(seasonArtifactFailures(root, 3, registry)).toEqual([])
    rmSync(path.join(root, 'tests/artifacts/registry/performance-season-2.json'))
    expect(seasonArtifactFailures(root, 3, registry)).toEqual(['missing season 2 artifact tests/artifacts/registry/performance-season-2.json'])
    writeSeason(2, registry())
    rmSync(path.join(root, 'tests/snapshots/season-3'), { recursive: true })
    expect(seasonArtifactFailures(root, 3, registry)).toEqual(['missing season 3 artifact tests/snapshots/season-3/summary.json'])
    writeSeason(3, registry())
    writeSeason(4, registry())
    expect(seasonArtifactFailures(root, 3, registry)).toEqual(['unexpected season 4 artifacts beyond the 3-season run'])
  })
})

describe('fake upstream handoff', () => {
  const servers: { close: () => Promise<void> }[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())) })

  const start = async () => {
    const fake = createFakeUpstreamServer()
    const server = await fake.listen(0)
    servers.push(fake)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      return response.json()
    }
    return { fake, call }
  }

  it('restores the exact upstream state a later shard resumes from', async () => {
    const first = await start()
    await first.call('POST', '/admin/now', { now: '2029-10-20T12:00:00.000Z' })
    await first.call('POST', '/admin/advance-season')
    await first.call('POST', '/admin/advance-season')
    await first.call('POST', '/admin/injury', { playerId: '1001', status: 'Out' })
    await first.call('GET', '/v1/players/nba')
    const before = await first.call('GET', '/admin/state')
    const saved = JSON.parse(JSON.stringify(first.fake.exportState()))

    const second = await start()
    expect(await second.call('GET', '/admin/state')).not.toEqual(before)
    second.fake.restoreState(saved)
    expect(await second.call('GET', '/admin/state')).toEqual(before)
    expect(second.fake.state.hits).toEqual(first.fake.state.hits)
    expect((await second.call('POST', '/admin/advance-season')).seasonYear)
      .toBe((await first.call('POST', '/admin/advance-season')).seasonYear)
    expect(() => second.fake.restoreState({ ...saved, players: undefined })).toThrow('incomplete')
  })
})

describe('soak shard plan inputs', () => {
  const filenames = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort()
  const release = JSON.parse(readFileSync('tests/e2e/release-history-attestations.json', 'utf8'))
  const pending = release.approvedMigrations.map((row: { version: string, name: string }) => `${row.version}_${row.name}.sql`)
  const input = {
    filenames,
    deployedVersion: release.baselineVersion,
    pendingFiles: pending,
    pendingVersions: release.approvedMigrations.map((row: { version: string }) => row.version),
    repositoryHead: release.approvedMigrations.at(-1).version,
  }

  it('accepts the attested range and rejects any drift from it', () => {
    expect(soakShardPlanFailures(input)).toEqual([])
    expect(soakShardPlanFailures({ ...input, pendingFiles: pending.slice(1) })).toEqual(['pending migration files differ from the attested plan'])
    expect(soakShardPlanFailures({ ...input, repositoryHead: release.baselineVersion })).toEqual(['repository migration head differs from the attested plan'])
    expect(soakShardPlanFailures({ ...input, deployedVersion: '99990101000001' })[0]).toContain('ahead of repository head')
  })
})

describe('release soak shard workflows', () => {
  const plan = readFileSync('.github/workflows/release-soak.yml', 'utf8')
  const shard = readFileSync('.github/workflows/release-soak-shard.yml', 'utf8')
  const seasons = Number(JSON.parse(readFileSync('package.json', 'utf8')).scripts['e2e:soak:release'].match(/--seasons=(\d+)/)[1])
  const shardCount = [...plan.matchAll(/^ {2}soak-shard-(\d+):$/gm)].length

  it('chains every shard after the attested plan and keeps each job bounded', () => {
    expect(seasons).toBe(20)
    expect(shardCount).toBe(4)
    for (let index = 1; index <= shardCount; index += 1) {
      const block = plan.split(`  soak-shard-${index}:\n`)[1].split(/\n {2}\S/)[0]
      expect(block).toContain(`needs: [release-soak${index > 1 ? `, soak-shard-${index - 1}` : ''}]`)
      expect(block).toContain('uses: ./.github/workflows/release-soak-shard.yml')
      expect(block).toContain(`shard: ${index}\n`)
      expect(block).toContain(`shard_count: ${shardCount}\n`)
      expect(block).toContain('migration_plan_sha256: ${{ needs.release-soak.outputs.migration_plan_sha256 }}')
      expect(block).toContain('secrets: inherit')
    }
    expect(Math.max(...planSoakShards(seasons, shardCount).map(({ firstSeason, lastSeason }) => lastSeason - firstSeason + 1))).toBeLessThanOrEqual(5)
    expect([...`${plan}\n${shard}`.matchAll(/timeout-minutes: (\d+)/g)].every((match) => Number(match[1]) <= 180)).toBe(true)
    expect(shard).toContain(`--require-season-reports=${seasons}`)
  })

  it('hands state forward and runs release-wide checks only in the final shard', () => {
    const step = (name: string) => shard.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0] ?? ''
    expect(step('Seed release fixture')).toContain('if: inputs.shard == 1')
    expect(step('Restore the previous shard database and checkpoint')).toContain('if: inputs.shard > 1')
    expect(step('Restore the previous shard database and checkpoint')).toContain('bash tests/e2e/soak-state.sh restore')
    expect(step('Package the soak state for the next shard')).toContain('supabase stop\n          bash tests/e2e/soak-state.sh save')
    const stateScript = readFileSync('tests/e2e/soak-state.sh', 'utf8')
    expect(stateScript).toContain('sha256sum --check --strict SHA256SUMS')
    expect(stateScript).toContain('volumes=("supabase_db_${project_id}" "supabase_storage_${project_id}")')
    expect(stateScript).toMatch(/image='debian@sha256:[0-9a-f]{64}'/)
    expect(step('Package the soak state for the next shard')).toContain('if: inputs.shard < inputs.shard_count')
    expect(step('Hand the soak state to the next shard')).toContain('name: release-soak-shard-${{ inputs.shard }}-state')
    for (const finalStep of [
      'Re-attest the deployed baseline and migration plan',
      'Verify cross-version runtime compatibility against upgraded schema',
      'Measure post-migration ranked workflow data latency',
      'Enforce browser and data performance budgets',
    ]) {
      expect(step(finalStep), finalStep).toContain('if: inputs.shard == inputs.shard_count')
    }
    expect(step('Re-attest the deployed baseline and migration plan')).toContain('test "$plan_sha256" = "$E2E_SOAK_MIGRATION_PLAN_SHA256"')
    expect(shard.indexOf('Run coverage-enforcing soak')).toBeLessThan(shard.indexOf('Package the soak state for the next shard'))
    expect(shard.indexOf('Re-attest the deployed baseline and migration plan'))
      .toBeLessThan(shard.indexOf('Verify cross-version runtime compatibility against upgraded schema'))
    expect(shard).toContain('E2E_SOAK_SHARD: ${{ inputs.shard }}/${{ inputs.shard_count }}')
    expect(shard).toContain('node tests/e2e/soak-shard-plan-check.mjs')
  })
})
