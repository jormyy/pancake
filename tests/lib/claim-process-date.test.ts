import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: vi.fn() }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))

import { claimProcessDateLabel } from '@/lib/waivers'

describe('claimProcessDateLabel', () => {
    it("uses the day the player's waiver period ends, in league time", () => {
        // 03:00 UTC on Oct 12 is still Oct 11 in New York.
        expect(claimProcessDateLabel('2026-10-12T03:00:00Z', new Date('2026-10-08T05:00:00Z'))).toBe('Sun, Oct 11')
        expect(claimProcessDateLabel('2026-10-12T16:00:00Z', new Date('2026-10-08T05:00:00Z'))).toBe('Mon, Oct 12')
    })

    it('falls back to the next nightly run when the end is unknown', () => {
        expect(claimProcessDateLabel(null, new Date('2026-10-08T16:00:00Z'))).toBe('Fri, Oct 9')
    })
})
