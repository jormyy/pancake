import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))
vi.mock('../src/config', () => ({ CONFIG: { ROOKIE_DRAFT_ROUNDS: 3 } }))

import { supabase } from '../src/lib/supabase'
import { makeSnakePick, autoPickBest, startRookieDraft } from '../src/sync/rookieDraft'

const mockFrom = vi.mocked(supabase.from)
const mockRpc = vi.mocked(supabase.rpc)

beforeEach(() => vi.clearAllMocks())

function q(data: any = null, error: any = null, count: number | null = null) {
    const result = { data, error, count }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        is: () => chain,
        gt: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        insert: () => Promise.resolve(result),
        update: () => q(data, error, count),
        delete: () => q(data, error, count),
        upsert: () => Promise.resolve(result),
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return chain
}

// makeSnakePick now delegates to the make_snake_pick_atomic RPC; the TS side
// only handles post-pick non-critical work (roster overflow + taxi + push
// notification). These helpers build that picture.
function rpcOk(payload: Partial<{
    pick: { id: string; overall_pick: number; round: number; pick_in_round: number; member_id: string; draft_pick_id: string | null }
    remaining: number
    completed: boolean
    league_id: string
    league_season_id: string
}> = {}) {
    return Promise.resolve({
        data: {
            pick: payload.pick ?? {
                id: 'sp1', overall_pick: 5, round: 2, pick_in_round: 3,
                member_id: 'm1', draft_pick_id: null,
            },
            remaining: payload.remaining ?? 3,
            completed: payload.completed ?? false,
            league_id: payload.league_id ?? 'lg1',
            league_season_id: payload.league_season_id ?? 's1',
        },
        error: null,
    })
}

function rpcErr(message: string) {
    return Promise.resolve({ data: null, error: { message } as any })
}

// makeSnakePick's post-RPC reads, in order:
//   1. leagues -> roster_size, taxi_slots
//   2. roster_players -> activeCount
//   3. roster_players -> taxiCount  (these two run via Promise.all)
//   4. players -> display_name
//   5. league_members -> user_id (inside notifyMember)
// Tests that need to inspect activeCount/taxiCount override step 2/3.
function defaultPostRpcMocks(opts: {
    rosterSize?: number
    taxiSlots?: number
    activeCount?: number
    taxiCount?: number
} = {}) {
    let n = 0
    mockFrom.mockImplementation(() => {
        n++
        if (n === 1) return q({ roster_size: opts.rosterSize ?? 20, taxi_slots: opts.taxiSlots ?? 2 }) as any
        if (n === 2) return q(null, null, opts.activeCount ?? 15) as any
        if (n === 3) return q(null, null, opts.taxiCount ?? 1) as any
        if (n === 4) return q({ display_name: 'Player' }) as any
        return q(null) as any
    })
}

// ── makeSnakePick ─────────────────────────────────────────────────────────────
//
// makeSnakePick now delegates the entire correctness-critical path to the
// `make_snake_pick_atomic` SECURITY DEFINER RPC (advisory-locked, FOR UPDATE
// next-pick row, all writes in one transaction). These tests exercise the
// TS-side glue: RPC error propagation, and the post-pick UI hints
// (rosterOverflow / taxiSlotsAvailable / draft-completed log).

describe('makeSnakePick', () => {
    it('propagates the RPC error message when the RPC fails', async () => {
        mockRpc.mockReturnValueOnce(rpcErr('Draft is not in progress') as any)
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow('not in progress')
    })

    it('propagates a "not your pick" RPC error', async () => {
        mockRpc.mockReturnValueOnce(rpcErr("It's not your pick") as any)
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow("not your pick")
    })

    it('propagates "Player is already on a roster" from the RPC', async () => {
        mockRpc.mockReturnValueOnce(rpcErr('Player is already on a roster') as any)
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow('already on a roster')
    })

    it('propagates "Player already picked in this draft" from the RPC', async () => {
        mockRpc.mockReturnValueOnce(rpcErr('Player already picked in this draft') as any)
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow('already picked')
    })

    it('invokes the RPC with the draft, member, and player ids', async () => {
        mockRpc.mockReturnValueOnce(rpcOk() as any)
        defaultPostRpcMocks()
        await makeSnakePick('d1', 'm1', 'p1')
        expect(mockRpc).toHaveBeenCalledWith('make_snake_pick_atomic', {
            p_draft_id: 'd1',
            p_member_id: 'm1',
            p_player_id: 'p1',
        })
    })

    it('returns rosterOverflow: true when active roster count exceeds roster_size', async () => {
        mockRpc.mockReturnValueOnce(rpcOk({ remaining: 3 }) as any)
        defaultPostRpcMocks({ rosterSize: 20, activeCount: 21 })
        const result = await makeSnakePick('d1', 'm1', 'p1')
        expect(result.rosterOverflow).toBe(true)
    })

    it('returns rosterOverflow: false when within roster_size', async () => {
        mockRpc.mockReturnValueOnce(rpcOk({ remaining: 5 }) as any)
        defaultPostRpcMocks({ rosterSize: 20, activeCount: 15 })
        const result = await makeSnakePick('d1', 'm1', 'p1')
        expect(result.rosterOverflow).toBe(false)
    })

    it('returns taxiSlotsAvailable: true when below taxi limit', async () => {
        mockRpc.mockReturnValueOnce(rpcOk({ remaining: 2 }) as any)
        defaultPostRpcMocks({ taxiSlots: 3, taxiCount: 2 })
        const result = await makeSnakePick('d1', 'm1', 'p1')
        expect(result.taxiSlotsAvailable).toBe(true)
    })

    it('reports draft completion when the RPC says so', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        mockRpc.mockReturnValueOnce(rpcOk({ remaining: 0, completed: true }) as any)
        defaultPostRpcMocks()
        const result = await makeSnakePick('d1', 'm1', 'p1')
        expect(result.remaining).toBe(0)
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Draft d1 completed'))
        logSpy.mockRestore()
    })

    it('returns the pick shape and newPlayerId from the RPC payload', async () => {
        const pick = {
            id: 'sp1', overall_pick: 7, round: 3, pick_in_round: 1,
            member_id: 'm1', draft_pick_id: 'dp-7',
        }
        mockRpc.mockReturnValueOnce(rpcOk({ pick, remaining: 11 }) as any)
        defaultPostRpcMocks()
        const result = await makeSnakePick('d1', 'm1', 'p9')
        expect(result.pick).toEqual(pick)
        expect(result.remaining).toBe(11)
        expect(result.newPlayerId).toBe('p9')
    })
})

// ── autoPickBest ──────────────────────────────────────────────────────────────

describe('autoPickBest', () => {
    it('surfaces already-picked query failures before choosing an auto-pick', async () => {
        mockFrom.mockReturnValueOnce(q(null, new Error('picked read failed')) as any)

        await expect(autoPickBest('d1', 'm1')).rejects.toThrow('picked read failed')
        expect(mockRpc).not.toHaveBeenCalled()
    })

    it('surfaces rookie candidate query failures before choosing an auto-pick', async () => {
        mockFrom
            .mockReturnValueOnce(q([]) as any)
            .mockReturnValueOnce(q(null, new Error('rookie candidates failed')) as any)

        await expect(autoPickBest('d1', 'm1')).rejects.toThrow('rookie candidates failed')
        expect(mockRpc).not.toHaveBeenCalled()
    })

    it('selects the player with the lowest available nba_draft_number', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            // autoPickBest's own queries
            if (n === 1) return q([{ player_id: 'p1' }]) as any  // already-picked ids
            if (n === 2) return q([{ id: 'p2' }, { id: 'p3' }]) as any // available sorted by draft#
            // makeSnakePick's post-RPC reads:
            if (n === 3) return q({ roster_size: 20, taxi_slots: 2 }) as any
            if (n === 4) return q(null, null, 15) as any
            if (n === 5) return q(null, null, 1) as any
            if (n === 6) return q({ display_name: 'P2' }) as any
            return q(null) as any
        })
        mockRpc.mockReturnValueOnce(rpcOk() as any)
        const result = await autoPickBest('d1', 'm1')
        // p1 was already picked → p2 should be chosen (lowest available)
        expect(result.newPlayerId).toBe('p2')
        expect(mockRpc).toHaveBeenCalledWith('make_snake_pick_atomic', expect.objectContaining({
            p_player_id: 'p2',
        }))
    })

    it('skips players already picked in this draft', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q([{ player_id: 'p1' }, { player_id: 'p2' }]) as any
            if (n === 2) return q([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]) as any
            if (n === 3) return q({ roster_size: 20, taxi_slots: 2 }) as any
            if (n === 4) return q(null, null, 15) as any
            if (n === 5) return q(null, null, 1) as any
            if (n === 6) return q({ display_name: 'P3' }) as any
            return q(null) as any
        })
        mockRpc.mockReturnValueOnce(rpcOk() as any)
        const result = await autoPickBest('d1', 'm1')
        expect(result.newPlayerId).toBe('p3')
        expect(mockRpc).toHaveBeenCalledWith('make_snake_pick_atomic', expect.objectContaining({
            p_player_id: 'p3',
        }))
    })

    it('throws when no available rookies remain', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q([{ player_id: 'p1' }, { player_id: 'p2' }]) as any
            if (n === 2) return q([{ id: 'p1' }, { id: 'p2' }]) as any // all picked
            return q(null) as any
        })
        await expect(autoPickBest('d1', 'm1')).rejects.toThrow('No available players')
    })
})

// ── startRookieDraft ──────────────────────────────────────────────────────────

describe('startRookieDraft', () => {
    it('delegates rookie startup to the atomic RPC with configured rounds', async () => {
        mockRpc.mockReturnValueOnce(Promise.resolve({
            data: { id: 'd1', league_id: 'lg1', draft_type: 'snake', status: 'in_progress' },
            error: null,
        }) as any)

        const draft = await startRookieDraft('lg1')

        expect(draft.id).toBe('d1')
        expect(mockRpc).toHaveBeenCalledWith('start_rookie_draft_atomic', {
            p_league_id: 'lg1',
            p_rounds: 3,
        })
        expect(mockFrom).not.toHaveBeenCalled()
    })

    it('propagates rookie startup RPC errors', async () => {
        mockRpc.mockReturnValueOnce(Promise.resolve({
            data: null,
            error: { message: 'A rookie draft already exists for this season' },
        }) as any)

        await expect(startRookieDraft('lg1')).rejects.toThrow('already exists')
    })
})
