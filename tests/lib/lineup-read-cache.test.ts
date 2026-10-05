import { beforeEach, describe, expect, it, vi } from 'vitest'

// The lineup read's short-lived caches: silent refreshes reuse slot templates
// (5 min) and rosters (60 s), concurrent reads share one request, a realtime
// roster invalidation forces a fresh read, and a failed read is never kept.

const state = vi.hoisted(() => ({
    counts: new Map<string, number>(),
    failTemplates: 0,
}))

vi.mock('@/lib/supabase', async () => {
    const fixtures = {
        lineup_slot_templates: [{ league_id: 'league', slot_type: 'PG', slot_count: 1 }],
        roster_players: [],
        weekly_lineups: [],
    }
    const fake = (await import('../helpers/fake-supabase')).createFakeSupabase(state.counts, fixtures)
    return {
        supabase: {
            ...fake,
            from: (table: string) => {
                if (table === 'lineup_slot_templates' && state.failTemplates > 0) {
                    state.failTemplates -= 1
                    state.counts.set(table, (state.counts.get(table) ?? 0) + 1)
                    const failed = { eq: () => failed, then: (resolve: (value: unknown) => void) => resolve({ data: null, error: new Error('templates offline') }) }
                    return { select: () => failed }
                }
                return fake.from(table)
            },
        },
    }
})
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2099-01-01', endOfETDayUTC: () => '2099-01-02T05:00:00.000Z' }))

import { getWeeklyLineup, invalidateCachedRoster } from '@/lib/lineup'
import { clearSessionCaches } from '@/lib/session-cache-registry'

const read = (options?: { allowCachedStatics?: boolean }) =>
    getWeeklyLineup('member', 'league', 'season', 3, '2099-01-01', options)
const reads = (table: string) => state.counts.get(table) ?? 0

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2099-01-01T12:00:00Z'))
    clearSessionCaches()
    state.counts.clear()
    state.failTemplates = 0
})

describe('lineup read caches', () => {
    it('a silent refresh hits the cached templates and roster; a full load misses them', async () => {
        await read()
        await read({ allowCachedStatics: true })
        expect([reads('lineup_slot_templates'), reads('roster_players'), reads('weekly_lineups')]).toEqual([1, 1, 2])

        await read()
        expect([reads('lineup_slot_templates'), reads('roster_players')]).toEqual([2, 2])
    })

    it('a roster invalidation makes the next silent refresh read the roster again', async () => {
        await read()
        invalidateCachedRoster('member', 'league', 'season')
        await read({ allowCachedStatics: true })

        expect(reads('roster_players')).toBe(2)
        expect(reads('lineup_slot_templates')).toBe(1)
    })

    it('a read started after an invalidation does not join the read in flight before it', async () => {
        const before = read()
        invalidateCachedRoster('member', 'league', 'season')
        await Promise.all([before, read()])

        expect(reads('roster_players')).toBe(2)
    })

    it('expires the roster after 60 s and the templates after 5 minutes', async () => {
        await read()
        vi.advanceTimersByTime(61_000)
        await read({ allowCachedStatics: true })
        expect([reads('lineup_slot_templates'), reads('roster_players')]).toEqual([1, 2])

        vi.advanceTimersByTime(5 * 60_000)
        await read({ allowCachedStatics: true })
        expect([reads('lineup_slot_templates'), reads('roster_players')]).toEqual([2, 3])
    })

    it('does not keep a failed template read; the next read retries', async () => {
        state.failTemplates = 1
        await expect(read()).rejects.toThrow('templates offline')
        await read({ allowCachedStatics: true })

        expect(reads('lineup_slot_templates')).toBe(2)
    })
})
