import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: vi.fn() }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))

import { claimRunAt, claimProcessDateLabel, claimProcessWeekdayLabel, claimProcessTimeLabel } from '@/lib/waivers'

describe('claimProcessDateLabel', () => {
    it('uses the first 12:00 AM PT run after the waiver period', () => {
        expect(claimProcessDateLabel('2026-10-12T03:00:00Z', new Date('2026-10-08T05:00:00Z'))).toBe('Mon, Oct 12 · 12:00 AM PT')
        expect(claimProcessDateLabel('2026-10-12T16:00:00Z', new Date('2026-10-08T05:00:00Z'))).toBe('Tue, Oct 13 · 12:00 AM PT')
    })

    it.each([
        ['2026-10-08T06:59:59Z', '2026-10-08T07:00:00.000Z'],
        ['2026-10-08T07:00:00Z', '2026-10-09T07:00:00.000Z'],
        ['2026-10-08T07:00:01Z', '2026-10-09T07:00:00.000Z'],
        ['2026-03-08T07:59:59Z', '2026-03-08T08:00:00.000Z'],
        ['2026-03-08T08:00:00Z', '2026-03-09T07:00:00.000Z'],
        ['2026-03-08T08:00:01Z', '2026-03-09T07:00:00.000Z'],
        ['2026-11-01T06:59:59Z', '2026-11-01T07:00:00.000Z'],
        ['2026-11-01T07:00:00Z', '2026-11-02T08:00:00.000Z'],
        ['2026-11-01T07:00:01Z', '2026-11-02T08:00:00.000Z'],
    ])('schedules an unknown clear time at %s', (now, expected) => {
        expect(claimRunAt(null, new Date(now)).toISOString()).toBe(expected)
    })

    it.each([
        ['2026-03-07T08:00:01Z', '2026-03-08T08:00:00.000Z'],
        ['2026-10-31T07:00:01Z', '2026-11-01T07:00:00.000Z'],
        ['2026-10-08T06:59:59Z', '2026-10-08T07:00:00.000Z'],
        ['2026-10-08T07:00:00Z', '2026-10-08T07:00:00.000Z'],
        ['2026-10-08T07:00:01Z', '2026-10-09T07:00:00.000Z'],
    ])('schedules a future clear time at %s', (clearsAt, expected) => {
        expect(claimRunAt(clearsAt, new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(expected)
    })

    it('uses now for an overdue clear time and formats the same run in each label', () => {
        const now = new Date('2026-10-08T16:00:00Z')
        expect(claimRunAt('2026-10-07T00:00:00Z', now).toISOString()).toBe('2026-10-09T07:00:00.000Z')
        expect(claimProcessDateLabel(null, now)).toBe('Fri, Oct 9 · 12:00 AM PT')
        expect(claimProcessWeekdayLabel(null, now)).toBe('Fri')
        expect(claimProcessTimeLabel(null, now)).toBe('Fri 12:00 AM PT')
    })
})

it('uses the configured league timezone instead of the default', () => {
    const now = new Date('2026-10-28T04:21:00Z')
    expect(claimRunAt(null, now, 'Asia/Tokyo').toISOString()).toBe('2026-10-28T15:00:00.000Z')
    expect(claimProcessDateLabel(null, now, 'Asia/Tokyo')).toBe('Thu, Oct 29 · 12:00 AM GMT+9')
})
