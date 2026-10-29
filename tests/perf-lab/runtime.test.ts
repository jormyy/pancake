import { describe, expect, it } from 'vitest'
import { command } from '../../scripts/perf-lab/process.mjs'
import { failedTwoDayReceipt, twoDayGates } from '../../scripts/perf-lab/gates.mjs'
import { redactHar, substitute } from '../../scripts/perf-lab/walk.mjs'

describe('capture and runtime failures', () => {
  it('limits headshot identity cleanup to the two synthetic fixture namespaces', async () => {
    const { clearSyntheticImageIdsSql } = await import('../../scripts/perf-lab/runtime.mjs')
    expect(clearSyntheticImageIdsSql).toContain("sportsdata_id LIKE 'ios-sim-%' AND nba_id ~ '^IOS[0-9]+$'")
    expect(clearSyntheticImageIdsSql).toContain("sportsdata_id LIKE 'e2e-player-%' AND nba_id ~ '^E2ENBA[0-9]+$'")
    expect(clearSyntheticImageIdsSql).not.toContain('DELETE')
  })
  it('rejects proxy targets outside the private loopback service', async () => {
    const { networkProxy } = await import('../../scripts/perf-lab/network-proxy.mjs')
    await expect(networkProxy('https://example.com:57284')).rejects.toThrow()
    await expect(networkProxy('https://localhost:443')).rejects.toThrow()
  })
  it('rejects a closed input pipe without an uncaught process error', async () => {
    await expect(command(process.execPath, ['-e', 'process.exit(3)'], { input: 'x'.repeat(4 * 1024 * 1024) })).rejects.toThrow('failed (3)')
  })
  it('retains a lost database connection without exposing SQL context', async () => {
    await expect(command(process.execPath, ['-e', 'process.stderr.write("psql: server closed the connection unexpectedly\\nCONTEXT: secret SQL\\n");process.exit(2)']))
      .rejects.toThrow('psql: server closed the connection unexpectedly')
  })
  it('removes credentials from HAR while retaining wire sizes', () => {
    const har = { log: { entries: [{ startedDateTime: '2026-10-28T00:00:00Z', request: { url: 'http://localhost:57221/token?key=secret', headers: [{ name: 'Authorization', value: 'secret' }], cookies: [{ value: 'secret' }], queryString: [{ name: 'key', value: 'secret' }], postData: { text: 'secret' }, bodySize: 6 }, response: { headers: [], cookies: [], content: { text: 'secret', size: 12 } } }] } }
    expect(JSON.stringify(redactHar(har))).not.toContain('secret')
    expect(har.log.entries[0].request.bodySize).toBe(6)
    expect(har.log.entries[0].response.content.size).toBe(12)
  })
  it('rejects missing fixture values before UI actions', () => {
    expect(substitute('/player/{{player.id}}', { player: { id: 'fixture' } })).toBe('/player/fixture')
    expect(() => substitute('/player/{{missing.id}}', {})).toThrow('Missing fixture')
  })
})

describe('two-day acceptance', () => {
  const valid = () => ({ liveSamples: 4, events: { live: 4, 'pre-tipoff': 2 }, days: [0, 1].map(() => ({ finals: { passed: true }, lineups: { postLockRejections: 1 }, forecasts: [{}] })), waivers: [{ checked: true, result: {} }], twoDayTrade: { proposed: 'first', countered: 'second', completed: true }, realtime: { passed: true } })
  it('records an attempted failure even when an earlier checkpoint looks complete', () => {
    expect(failedTwoDayReceipt(valid(), 'worker failed')).toMatchObject({ attempted: true, passed: false, error: 'worker failed' })
    expect(Object.values(failedTwoDayReceipt({}, 'startup failed').gates).every(value => value === false)).toBe(true)
  })
  it('requires measured evidence for every named gate', () => {
    expect(Object.values(twoDayGates(valid())).every(Boolean)).toBe(true)
    expect(Object.values(twoDayGates({})).every(Boolean)).toBe(false)
    for (const field of ['liveSamples', 'events', 'days', 'waivers', 'twoDayTrade', 'realtime']) {
      const incomplete: Record<string, unknown> = valid()
      delete incomplete[field]
      expect(Object.values(twoDayGates(incomplete)).every(Boolean)).toBe(false)
    }
  })
})

describe('identity negative control', () => {
  it('accepts only the reproduced split failure before the repair', async () => {
    const { checkIdentity } = await import('../../scripts/perf-lab/identity-check.mjs')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const directory = await mkdtemp(`${tmpdir()}/identity-proof-`)
    try {
      const split = async () => { throw new Error('Complementary null-team source identities stay split') }
      expect(await checkIdentity('split', directory, split)).toMatchObject({ negativeControl: true, checks: 1 })
      await expect(checkIdentity('linked', directory, split)).rejects.toThrow()
      await expect(checkIdentity('split', directory, async () => { throw new Error('timeout') })).rejects.toThrow()
      expect(await checkIdentity('linked', directory, async () => '{}')).toMatchObject({ negativeControl: false, checks: 16 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('frozen screen actions', () => {
  it('accepts every declared action and rejects unknown operations', async () => {
    const { actionKind } = await import('../../scripts/perf-lab/actions.mjs')
    const { inventory } = await import('../../scripts/perf-lab/workloads.mjs')
    const work = await inventory()
    for (const scenario of work.scenarios) {
      for (const action of scenario.prepare ?? []) expect(actionKind(action)).toBeTruthy()
      for (const step of scenario.steps) expect(actionKind(step.action)).toBeTruthy()
    }
    expect(() => actionKind({ unsupported: true })).toThrow('one supported operation')
    expect(() => actionKind({ tap: 'Save', open: '/' })).toThrow('one supported operation')
  })
})

describe('historical provider boundaries', () => {
  it('classifies a missing historical rankings input before counting worker recovery', async () => {
    const { isKnownProjectionGap } = await import('../../scripts/perf-lab/provider-gaps.mjs')
    const outcome = { invocation_key: 'rank', function_name: 'sync-rankings', status_code: 500, worker_status: 'failed' }
    const request = { invocation: 'rank', function: 'sync-rankings', status: 503, unavailable: { code: 'HISTORICAL_UNAVAILABLE', source: 'hashtag-rankings' } }
    expect(isKnownProjectionGap(outcome, [request])).toBe(true)
    expect(isKnownProjectionGap(outcome, [{ ...request, invocation: 'other' }])).toBe(false)
    expect(isKnownProjectionGap(outcome, [{ ...request, unavailable: null }])).toBe(false)
  })
  it('only accepts a correlated recorded projection gap', async () => {
    const { isKnownProjectionGap } = await import('../../scripts/perf-lab/provider-gaps.mjs')
    const outcome = { invocation_key: 'one', function_name: 'sync-sleeper-projections', status_code: 500, worker_status: 'failed' }
    const requests = [{ invocation: 'one', function: outcome.function_name, status: 503, unavailable: { code: 'HISTORICAL_UNAVAILABLE', source: 'sleeper-projections' } }]
    expect(isKnownProjectionGap(outcome, requests)).toBe(true)
    expect(isKnownProjectionGap({ ...outcome, status_code: 404 }, requests)).toBe(false)
    expect(isKnownProjectionGap({ ...outcome, invocation_key: 'other' }, requests)).toBe(false)
    expect(isKnownProjectionGap({ ...outcome, function_name: 'live-poll' }, requests)).toBe(false)
    expect(isKnownProjectionGap(outcome, [])).toBe(false)
  })
})

describe('route content contracts', () => {
  it('declares a visible content target for every route and tab section', async () => {
    const { expectedSurface } = await import('../../scripts/perf-lab/surfaces.mjs')
    const { inventory } = await import('../../scripts/perf-lab/workloads.mjs')
    const work = await inventory()
    for (const surface of work.surfaces.filter((row: { scenario?: string }) => !row.scenario)) {
      const expected = expectedSurface(surface, { teamName: 'A', otherTeam: 'B', displayName: 'C', freeAgent: { display_name: 'D' } }, 'commissioner')
      expect(expected.selector || expected.text || expected.all).toBeTruthy()
    }
  })
})

describe('Postgres stream redaction', () => {
  it('keeps duration evidence and removes local authentication values', async () => {
    const { redactPostgresLine } = await import('../../scripts/perf-lab/postgres-log.mjs')
    const line = "duration: 2.5 ms SET app.edge_internal_token = 'secret'; eyJabc.def.ghi"
    const result = redactPostgresLine(line)
    expect(result).toContain('duration: 2.5 ms')
    expect(result).not.toContain('secret')
    expect(result).not.toContain('eyJabc')
  })
})

describe('final-day fixtures', () => {
  it('restores game fields when a screen assertion fails', async () => {
    const { withDayPhase } = await import('../../scripts/perf-lab/phases.mjs')
    const commands: string[] = []
    const execute = async (query: string) => {
      commands.push(query)
      if (query.includes('json_agg')) return JSON.stringify([{ id: 'game', status: 'InProgress', game_time: null, started_at: null }])
      if (query.includes('json_build_object')) return JSON.stringify({ games: 1, final: 1, live: 0 })
      return ''
    }
    await expect(withDayPhase({ today: '2026-10-28' }, 'final', async () => { throw new Error('screen failed') }, execute)).rejects.toThrow('screen failed')
    expect(commands.at(-1)).toContain('jsonb_populate_recordset')
    expect(commands.at(-1)).toContain('InProgress')
  })
})

describe('compressed database capture', () => {
  it('keeps a complete redacted stream that can be decompressed', async () => {
    const { startPostgresLog } = await import('../../scripts/perf-lab/postgres-log.mjs')
    const { spawn } = await import('node:child_process')
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { gunzipSync } = await import('node:zlib')
    const path = await import('node:path')
    const directory = await mkdtemp(path.join(tmpdir(), 'perf-lab-log-'))
    try {
      let completed: Promise<unknown> | undefined
      const capture = startPostgresLog(path.join(directory, 'postgres.log.gz'), new Date().toISOString(), () => {
        const child = spawn(process.execPath, ['-e', 'process.stdout.write("duration: 4 ms eyJabc."); process.stdout.write("def.ghi\\n")'])
        completed = new Promise(resolve => child.once('close', resolve))
        return child
      })
      await completed
      await capture.close()
      expect(gunzipSync(await readFile(path.join(directory, 'postgres.log.gz'))).toString()).toBe('duration: 4 ms [redacted]\n')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('bounded workload selection', () => {
  it('rejects an unknown surface before any remote setup', async () => {
    const { run } = await import('../../scripts/perf-lab/run.mjs')
    const previous = process.env.PERF_LAB_SURFACE
    process.env.PERF_LAB_SURFACE = 'missing-surface'
    try { await expect(run('walk', 1)).rejects.toThrow('Unknown requested surface') }
    finally { if (previous === undefined) delete process.env.PERF_LAB_SURFACE; else process.env.PERF_LAB_SURFACE = previous }
  })
  it('keeps omitted rows unproved and rejects arbitrary shell input', async () => {
    const { workloadSelection, selectionEnvironment } = await import('../../scripts/perf-lab/selection.mjs')
    const selected = workloadSelection({ NODE_ENV: 'test', PERF_LAB_SCOPE: 'routes', PERF_LAB_STATES: 'cold', PERF_LAB_DAYS: 'final', PERF_LAB_ROLES: 'member' })
    expect(selected.states).toEqual(['cold'])
    expect(selected.days).toEqual(['final'])
    expect(workloadSelection({ NODE_ENV: 'test', PERF_LAB_CASES: 'players/member/final/cold' }).cases).toEqual(['players/member/final/cold'])
    expect(() => workloadSelection({ NODE_ENV: 'test', PERF_LAB_CASES: 'players;bad' })).toThrow()
    expect(() => selectionEnvironment({ NODE_ENV: 'test', PERF_LAB_SURFACE: 'home;bad' })).toThrow()
    expect(() => workloadSelection({ NODE_ENV: 'test', PERF_LAB_STATES: 'fake' })).toThrow()
    expect(workloadSelection({ NODE_ENV: 'test', PERF_LAB_STOP_ON_FAILURE: '1' }).stopOnFailure).toBe(true)
    expect(() => workloadSelection({ NODE_ENV: 'test', PERF_LAB_STOP_ON_FAILURE: 'yes' })).toThrow()
  })
})

describe('production retry fidelity', () => {
  it('waits for an active worker after its HTTP transport times out', async () => {
    const { cronDispatcher } = await import('../../scripts/season-sim/cron-dispatcher.mjs')
    for (const waitForWorkerOutcome of [false, true]) {
      let reads = 0, checks = 0
      const observed: string[] = []
      const driver = cronDispatcher((row: { worker_status: string }) => { observed.push(row.worker_status) }, {
        waitForWorkerOutcome, enqueueWork: async () => [{ id: 1, statement: 'fixture' }],
        query: async () => [{ id: 1, worker_status: ++reads === 1 ? 'running' : 'success', timed_out: true, error_msg: 'HTTP timeout' }],
        health: async () => ({ active: ++checks === 1 ? 1 : 0, sleeping: 0, fetches: 1 }),
        probe: { watch() {}, finish() {}, check: async () => {}, close: async () => {} }, recordOutcome: async () => {},
      })
      await driver.enqueue('fixture')
      await driver.drain(0)
      expect(observed).toEqual([waitForWorkerOutcome ? 'success' : 'running'])
      await driver.close()
    }
  })
  it('requires a real future queue retry and a later successful outcome', async () => {
    const { trackProductionRetry, retriesRecovered } = await import('../../scripts/perf-lab/retry-recovery.mjs')
    const report = {}
    const failed = { id: 1, status_code: 500, worker_status: 'failed', sync_error: 'Resolve: canceling statement due to lock timeout' }
    const read = async () => JSON.stringify([{ id: 7, status: 'failed', attempts: 1, due_at: 'next minute', future: true }])
    expect(await trackProductionRetry(failed, report, read)).toBe(true)
    expect(retriesRecovered(report)).toBe(false)
    await trackProductionRetry({ id: 2, status_code: 200, worker_status: 'success' }, report, async () => JSON.stringify([{ id: 7, status: 'succeeded', attempts: 2 }]))
    expect(retriesRecovered(report)).toBe(true)
    expect(await trackProductionRetry(failed, {}, async () => '[]')).toBe(false)
    expect(await trackProductionRetry(failed, {}, async () => JSON.stringify([{ id: 7, status: 'dead', attempts: 3, future: false }]))).toBe(false)
    expect(await trackProductionRetry({ ...failed, sync_error: 'Data mismatch' }, {}, read)).toBe(true)
    expect(await trackProductionRetry({ ...failed, status_code: 503 }, {}, read)).toBe(true)
    expect(await trackProductionRetry({ ...failed, worker_status: 'success' }, {}, read)).toBe(false)
    expect(await trackProductionRetry({ ...failed, sync_error: 'Data mismatch' }, {}, async () => JSON.stringify([{ id: 7, status: 'dead', attempts: 3, future: false }]))).toBe(false)
  })
})
