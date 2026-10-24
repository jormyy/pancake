import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/dates', () => ({ todayET: vi.fn().mockReturnValue('2026-04-22') }))

import { supabase } from '@/lib/supabase'
import { todayET } from '@/lib/shared/dates'
import { getCurrentWeekNumber, getSeasonWeekDates, invalidateWeekNumberCache } from '@/lib/shared/week'

const mockFrom = vi.mocked(supabase.from)
const mockTodayET = vi.mocked(todayET)

function seasonWeekQuery(data: unknown, error: unknown = null) {
    const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        lte: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        order: vi.fn().mockResolvedValue({ data, error }),
        limit: vi.fn(() => chain),
        maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    }
    return chain
}

describe('getCurrentWeekNumber', () => {
    beforeEach(() => {
        mockFrom.mockReset()
        mockTodayET.mockReturnValue('2026-04-22')
        invalidateWeekNumberCache()
    })

    it('memoizes the lookup per season/day', async () => {
        const query = seasonWeekQuery([{ week_number: 22, week_start: '2026-04-20', week_end: '2026-04-26' }])
        mockFrom.mockReturnValue(query)

        await expect(getCurrentWeekNumber(2026)).resolves.toBe(22)
        await expect(getCurrentWeekNumber(2026)).resolves.toBe(22)
        expect(mockFrom).toHaveBeenCalledTimes(1)
    })

    it('shares cached Monday-to-Sunday dates for a partial opening week', async () => {
        mockFrom.mockReturnValue(seasonWeekQuery([{ week_number: 1, week_start: '2025-10-21', week_end: '2025-10-26' }]))
        await expect(getCurrentWeekNumber(2026)).resolves.toBe(1)
        await expect(getSeasonWeekDates(2026, 1)).resolves.toEqual([
            '2025-10-20', '2025-10-21', '2025-10-22', '2025-10-23', '2025-10-24', '2025-10-25', '2025-10-26',
        ])
        expect(mockFrom).toHaveBeenCalledTimes(1)
        await expect(getSeasonWeekDates(2026, 99)).resolves.toEqual([])
    })

    it('uses the ET date key when querying season weeks', async () => {
        const query = seasonWeekQuery([{ week_number: 22, week_start: '2026-04-20', week_end: '2026-04-26' }])
        mockFrom.mockReturnValue(query)

        await expect(getCurrentWeekNumber(2026)).resolves.toBe(22)

        expect(query.eq).toHaveBeenCalledWith('season_year', 2026)
        expect(query.order).toHaveBeenCalledWith('week_number', { ascending: true })
    })

    it('returns the last seeded week after the schedule ends', async () => {
        mockTodayET.mockReturnValue('2026-09-15')
        const query = seasonWeekQuery([
            { week_number: 1, week_start: '2025-10-21', week_end: '2025-10-26' },
            { week_number: 25, week_start: '2026-04-06', week_end: '2026-04-12' },
        ])
        mockFrom.mockReturnValue(query)

        await expect(getCurrentWeekNumber(2026)).resolves.toBe(25)

        expect(query.order).toHaveBeenCalledWith('week_number', { ascending: true })
    })

    it('surfaces season week lookup errors instead of falling back to stale week math', async () => {
        const query = seasonWeekQuery(null, new Error('season weeks unavailable'))
        mockFrom.mockReturnValue(query)

        await expect(getCurrentWeekNumber(2026)).rejects.toThrow('season weeks unavailable')
    })
})
