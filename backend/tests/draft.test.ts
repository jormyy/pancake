import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../src/lib/supabase'
import { placeBid, nominatePlayer } from '../src/sync/draft'

function q(data: any = null, error: any = null) {
    const result = { data, error }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        insert: () => q(data, error),
        update: () => q(data, error),
        delete: () => q(data, error),
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return chain
}

const mockFrom = vi.mocked(supabase.from)
const mockRpc = vi.mocked(supabase.rpc)

beforeEach(() => vi.clearAllMocks())

// ── placeBid ─────────────────────────────────────────────────────────────────

describe('placeBid', () => {
    it('throws if bid is not an integer', async () => {
        await expect(placeBid('d1', 'm1', 'n1', 1.5)).rejects.toThrow('positive integer')
    })

    it('throws if bid is below MIN_BID (1)', async () => {
        await expect(placeBid('d1', 'm1', 'n1', 0)).rejects.toThrow('positive integer')
    })

    it('throws if nomination is not found', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Nomination not found') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 5)).rejects.toThrow('Nomination not found')
    })

    it('throws if nomination is not open', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Bidding is closed') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 15)).rejects.toThrow('Bidding is closed')
    })

    it('throws if countdown has expired', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Bidding window has expired') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 10)).rejects.toThrow('expired')
    })

    it('throws if bid does not exceed current bid', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Bid must exceed current bid') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 20)).rejects.toThrow('exceed current bid')
    })

    it('throws if member is already the highest bidder', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Member is already the highest bidder') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 20)).rejects.toThrow("already the highest bidder")
    })

    it('throws if member has insufficient budget', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Insufficient budget') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 50)).rejects.toThrow('Insufficient budget')
    })

    it('succeeds and returns { ok: true } for a valid bid', async () => {
        mockRpc.mockResolvedValue({ data: null, error: null } as any)

        const result = await placeBid('d1', 'm1', 'n1', 15)
        expect(result).toEqual({ ok: true })
        expect(mockRpc).toHaveBeenCalledWith('place_auction_bid_atomic', {
            p_draft_id: 'd1',
            p_member_id: 'm1',
            p_nomination_id: 'n1',
            p_amount: 15,
        })
    })
})

// ── nominatePlayer ────────────────────────────────────────────────────────────

describe('nominatePlayer', () => {
    const openDraft = {
        id: 'd1', league_id: 'lg1', league_season_id: 's1',
        current_nomination_order: 1, status: 'in_progress',
    }
    const orders = [
        { member_id: 'm1', position: 1 },
        { member_id: 'm2', position: 2 },
    ]

    it('throws if draft is not in_progress', async () => {
        const completedDraft = { ...openDraft, status: 'completed' }
        mockFrom.mockReturnValue(q(completedDraft) as any)
        await expect(nominatePlayer('d1', 'm1', 'p1')).rejects.toThrow('not in progress')
    })

    it('throws if it is not the member\'s turn', async () => {
        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(openDraft) as any // draft
            if (callCount === 2) return q(orders) as any    // draft_orders
            return q(null) as any
        })
        // m2's turn when nomination_order=1 → turnIndex=0 → orders[0].member_id = m1
        await expect(nominatePlayer('d1', 'm2', 'p1')).rejects.toThrow("not your turn")
    })

    it('throws if a nomination is already open', async () => {
        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(openDraft) as any            // draft
            if (callCount === 2) return q(orders) as any               // draft_orders
            if (callCount === 3) return q({ id: 'existing-nom' }) as any // open nomination exists
            return q(null) as any
        })
        await expect(nominatePlayer('d1', 'm1', 'p1')).rejects.toThrow('already open')
    })

    it('throws if player was already nominated in this draft', async () => {
        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(openDraft) as any        // draft
            if (callCount === 2) return q(orders) as any           // draft_orders
            if (callCount === 3) return q(null) as any             // no open nomination
            if (callCount === 4) return q({ id: 'nom1' }) as any   // already nominated
            return q(null) as any
        })
        await expect(nominatePlayer('d1', 'm1', 'p1')).rejects.toThrow('already nominated')
    })

    it('creates a nomination on success', async () => {
        const newNom = { id: 'nom-new', player_id: 'p1', status: 'open' }
        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(openDraft) as any  // draft
            if (callCount === 2) return q(orders) as any     // draft_orders
            if (callCount === 3) return q(null) as any       // no open nomination
            if (callCount === 4) return q(null) as any       // not already nominated
            if (callCount === 5) return q(0, null, 0) as any // count of nominations
            return q(newNom) as any                          // insert → select → single
        })

        const result = await nominatePlayer('d1', 'm1', 'p1')
        expect(result).toMatchObject({ id: 'nom-new', player_id: 'p1' })
    })
})
