import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
    supabase: {
        from: mocks.from,
        removeChannel: vi.fn(),
    },
}))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: vi.fn() }))

import { getDraftPollRevision } from '@/lib/draft'

function query(data: unknown) {
    const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({ data, error: null })),
    }
    return chain
}

describe('auction draft fallback poll budget', () => {
    beforeEach(() => vi.clearAllMocks())

    it('reads only the draft row and latest nomination regardless of history size', async () => {
        const draft = query({
            status: 'in_progress',
            current_nomination_order: 500,
            pause_reason: null,
            paused_at: null,
        })
        const nomination = query({
            id: 'nomination-500',
            status: 'open',
            current_bid_amount: 42,
            current_bidder_id: 'member-1',
            countdown_expires_at: '2026-07-09T12:00:00Z',
            closed_at: null,
        })
        mocks.from.mockImplementation((table: string) => table === 'drafts' ? draft : nomination)

        const revision = await getDraftPollRevision('draft-1')

        expect(revision).toContain('nomination-500')
        expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(['drafts', 'nominations'])
        expect(nomination.limit).toHaveBeenCalledWith(1)
        expect(mocks.from).not.toHaveBeenCalledWith('bids')
        expect(mocks.from).not.toHaveBeenCalledWith('dynasty_rankings')
    })
})
