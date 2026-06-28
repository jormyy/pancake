import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() },
}))

import { supabase } from '../src/lib/supabase'
import { closeExpiredNominations, placeBid, nominatePlayer, startDraft, withdrawNomination } from '../src/sync/draft'

const mockFrom = vi.mocked(supabase.from)
const mockRpc = vi.mocked(supabase.rpc)

beforeEach(() => vi.clearAllMocks())

function q(data: unknown, error: unknown = null) {
    const result = { data, error }
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'lt']) {
        chain[method] = vi.fn(() => chain)
    }
    chain.maybeSingle = vi.fn().mockResolvedValue(result)
    chain.then = (resolve: (value: unknown) => unknown, reject: (value: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject)
    return chain as any
}

describe('startDraft', () => {
    it('delegates auction startup to the atomic RPC with deterministic DB order', async () => {
        mockRpc.mockResolvedValue({
            data: { id: 'd1', league_id: 'lg1', draft_type: 'auction', status: 'in_progress' },
            error: null,
        } as any)

        const draft = await startDraft('lg1', 'alphabetical')

        expect(draft.id).toBe('d1')
        expect(mockRpc).toHaveBeenCalledWith('start_auction_draft_atomic', {
            p_league_id: 'lg1',
            p_nomination_order_mode: 'alphabetical',
        })
        expect(mockFrom).not.toHaveBeenCalled()
    })

    it('rejects invalid nomination-order modes before calling the RPC', async () => {
        await expect(startDraft('lg1', 'random' as any)).rejects.toThrow('Invalid nomination order mode')
        expect(mockRpc).not.toHaveBeenCalled()
    })
})

// ── placeBid ─────────────────────────────────────────────────────────────────

describe('placeBid', () => {
    it('throws if bid is not an integer', async () => {
        await expect(placeBid('d1', 'm1', 'n1', 1.5, 'u1')).rejects.toThrow('positive integer')
    })

    it('throws if bid is below MIN_BID (1)', async () => {
        await expect(placeBid('d1', 'm1', 'n1', 0, 'u1')).rejects.toThrow('positive integer')
    })

    it('throws if nomination is not found', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Nomination not found') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 5, 'u1')).rejects.toThrow('Nomination not found')
    })

    it('throws if nomination is not open', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Bidding is closed') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 15, 'u1')).rejects.toThrow('Bidding is closed')
    })

    it('throws if countdown has expired', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Bidding window has expired') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 10, 'u1')).rejects.toThrow('expired')
    })

    it('throws if bid does not exceed current bid', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Bid must exceed current bid') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 20, 'u1')).rejects.toThrow('exceed current bid')
    })

    it('throws if member is already the highest bidder', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Member is already the highest bidder') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 20, 'u1')).rejects.toThrow("already the highest bidder")
    })

    it('throws if member has insufficient budget', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('Insufficient budget') } as any)
        await expect(placeBid('d1', 'm1', 'n1', 50, 'u1')).rejects.toThrow('Insufficient budget')
    })

    it('succeeds and returns { ok: true } for a valid bid', async () => {
        mockRpc.mockResolvedValue({ data: null, error: null } as any)

        const result = await placeBid('d1', 'm1', 'n1', 15, 'u1')
        expect(result).toEqual({ ok: true })
        expect(mockRpc).toHaveBeenCalledWith('place_auction_bid_atomic', {
            p_draft_id: 'd1',
            p_member_id: 'm1',
            p_nomination_id: 'n1',
            p_amount: 15,
            p_user_id: 'u1',
        })
    })
})

// ── nominatePlayer ────────────────────────────────────────────────────────────

describe('nominatePlayer', () => {
    it('delegates nomination creation to the atomic RPC', async () => {
        const newNom = { id: 'nom-new', player_id: 'p1', status: 'open' }
        mockRpc.mockResolvedValue({ data: newNom, error: null } as any)

        const result = await nominatePlayer('d1', 'm1', 'p1', 'u1')

        expect(result).toMatchObject({ id: 'nom-new', player_id: 'p1' })
        expect(mockRpc).toHaveBeenCalledWith('create_auction_nomination_atomic', {
            p_draft_id: 'd1',
            p_member_id: 'm1',
            p_player_id: 'p1',
            p_user_id: 'u1',
            p_countdown_seconds: 30,
        })
        expect(mockFrom).not.toHaveBeenCalled()
    })

    it('surfaces atomic turn and lifecycle validation errors', async () => {
        mockRpc.mockResolvedValue({ data: null, error: new Error('It is not your turn to nominate') } as any)

        await expect(nominatePlayer('d1', 'm2', 'p1', 'u2')).rejects.toThrow('not your turn')
    })

    it('translates storage races into existing nomination errors', async () => {
        mockRpc.mockResolvedValue({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "nominations_one_open_per_draft"' },
        } as any)

        await expect(nominatePlayer('d1', 'm1', 'p1', 'u1')).rejects.toThrow('already open')

        mockRpc.mockResolvedValue({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "nominations_draft_id_player_id_key"' },
        } as any)

        await expect(nominatePlayer('d1', 'm1', 'p1', 'u1')).rejects.toThrow('already nominated')
    })
})

// ── withdrawNomination ───────────────────────────────────────────────────────

describe('withdrawNomination', () => {
    it('scopes visible nominations by draft and member before calling the RPC', async () => {
        mockFrom.mockReturnValue(q({ id: 'n1' }))
        mockRpc.mockResolvedValue({ data: true, error: null } as any)

        const result = await withdrawNomination('d1', 'm1', 'n1', 'u1')

        expect(result).toEqual({ ok: true, withdrawn: true })
        const chain = mockFrom.mock.results[0].value
        expect(mockFrom).toHaveBeenCalledWith('nominations')
        expect(chain.eq).toHaveBeenCalledWith('id', 'n1')
        expect(chain.eq).toHaveBeenCalledWith('draft_id', 'd1')
        expect(chain.eq).toHaveBeenCalledWith('nominating_member_id', 'm1')
        expect(chain.eq).toHaveBeenCalledWith('status', 'open')
        expect(mockRpc).toHaveBeenCalledWith('withdraw_auction_nomination_atomic', {
            p_nomination_id: 'n1',
            p_member_id: 'm1',
            p_user_id: 'u1',
        })
    })

    it('returns the same benign result for missing, wrong-draft, closed, or foreign nominations', async () => {
        mockFrom.mockReturnValue(q(null))

        const result = await withdrawNomination('d1', 'm1', 'n1', 'u1')

        expect(result).toEqual({ ok: true, withdrawn: false })
        expect(mockRpc).not.toHaveBeenCalled()
    })
})

describe('closeExpiredNominations', () => {
    it('surfaces nomination scan failures instead of reporting no expired nominations', async () => {
        mockFrom.mockReturnValue(q(null, new Error('nomination read failed')))

        await expect(closeExpiredNominations()).rejects.toThrow('nomination read failed')
        expect(mockRpc).not.toHaveBeenCalled()
    })
})
