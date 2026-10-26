import { describe, expect, it, vi } from 'vitest'
import { createSeasonPhaseTimings, formatPhaseTimings } from './e2e/harness/phase-timings.mjs'
import { validatePerfDrift } from './e2e/soak-support.mjs'
import { writeReport } from './e2e/harness/reporting.mjs'

const reportFiles = vi.hoisted(() => {
    process.env.E2E_PERF_DRIFT_LIMIT = '1.2'
    return new Map<string, string>()
})
vi.mock('./e2e/env.mjs', () => ({
    resolvedEnv: () => { throw new Error('Timing tests must not resolve credentials') },
    describeEndpoint: (value: string) => value,
    envValue: () => undefined,
    loadEnvFile: () => { throw new Error('Timing tests must not read env files') },
    isProductionSupabaseUrl: () => false,
    querySupabaseDb: () => { throw new Error('Timing tests must not query a database') },
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
    writeFile: vi.fn(async (file: string, text: string) => { reportFiles.set(file, text) }),
}))

describe('soak phase timing integration', () => {

    it('accounts for every interval through the original season cutoff, including work between phases', () => {
        let clock = 100
        const timings = createSeasonPhaseTimings(() => clock, clock)
        clock += 20
        timings.mark('startup')
        clock += 30
        timings.mark('invariants')
        clock += 50
        timings.mark('snapshots')
        clock += 10
        const durations = timings.finish(clock)
        expect(durations).toEqual({ startup: 20, invariants: 30, snapshots: 50, unattributed: 10 })
        const totalDuration = Object.values(durations).reduce<number>((total, duration) => {
            if (typeof duration !== 'number') throw new Error('Phase durations must be numbers')
            return total + duration
        }, 0)
        expect(totalDuration).toBe(clock - 100)
        expect(formatPhaseTimings(durations)).toBe('Phase times (ms): startup=20, invariants=30, snapshots=50, unattributed=10')
    })

    it('accumulates repeated phases and keeps earlier season measurements unchanged', () => {
        let clock = 0
        const timings = createSeasonPhaseTimings(() => clock, clock)
        clock = 15
        timings.mark('invariants')
        const first = timings.finish(clock)
        clock = 40
        timings.mark('invariants')
        expect(timings.finish(clock)).toEqual({ invariants: 40, unattributed: 0 })
        expect(first).toEqual({ invariants: 15, unattributed: 0 })
    })

    it('still fails the 20% gate when retained-history work adds 30% to the full season', () => {
        const metrics = Array.from({ length: 10 }, (_, index) => ({
            season: index + 1,
            durationMs: index < 3 ? 100 : 130,
            phaseDurationsMs: { scoring: 80, retained_history: index < 3 ? 20 : 50 },
        }))
        expect(validatePerfDrift(metrics, 10)).toEqual([
            'D.LONG.6: per-season runtime median drifted 30% from seasons 1-3 (100ms) to seasons 8-10 (130ms); limit is 20%',
        ])
    })

    it.each(['PASS', 'FAIL'])('keeps phase details in the %s Markdown and machine report', async (status) => {
        const phaseDurationsMs = { invariants: 25, history_retention: 40, snapshots: 30, unattributed: 5 }
        const row = { season: 1, status, durationMs: 100, phaseDurationsMs, notes: formatPhaseTimings(phaseDurationsMs) }
        await writeReport({ status, startedAt: 'start', finishedAt: 'end', seasons: 1, rows: [row], notes: [] })
        const markdown = [...reportFiles].find(([file]) => file.endsWith('e2e-report.md'))![1]
        const machine = JSON.parse([...reportFiles].find(([file]) => file.endsWith('e2e-report.json'))![1]) as { rows: typeof row[] }
        expect(markdown).toContain(`| 1 | ${status} | ${row.notes} |`)
        expect(machine.rows).toEqual([row])
    })
})
