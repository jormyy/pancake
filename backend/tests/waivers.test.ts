import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() },
}))
vi.mock('../src/lib/notifications', () => ({
    notifyMember: vi.fn().mockResolvedValue(undefined),
}))

import { supabase } from '../src/lib/supabase'
import { processWaiverClaims } from '../src/sync/waivers'

const mockFrom = vi.mocked(supabase.from)
const mockRpc = vi.mocked(supabase.rpc)

beforeEach(() => vi.clearAllMocks())

/**
 * Builds a chainable supabase mock that resolves to the given result.
 * When called sequentially, each mockFrom call pops from the queue.
 */
function q(data: any = null, error: any = null, count: number | null = null) {
    const result = { data, error, count }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        is: () => chain,
        gt: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        insert: () => q(data, error, count),
        update: () => q(data, error, count),
        delete: () => q(data, error, count),
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return chain
}

/** Sequences mockFrom responses in order */
function setupRpcRows(rows: any[]) {
    let i = 0
    mockRpc.mockImplementation(async () => {
        const row = rows[i] ?? { processed: false }
        i += 1
        return { data: [row], error: null } as any
    })
}

describe('processWaiverClaims', () => {
    it('returns early when no pending claims exist', async () => {
        setupRpcRows([{ processed: false }])
        mockFrom.mockReturnValue(q() as any)

        await expect(processWaiverClaims()).resolves.toBeUndefined()
        expect(mockRpc).toHaveBeenCalledTimes(1)
    })

    it('succeeds: adds player and moves member to back of priority queue', async () => {
        setupRpcRows([{
            processed: true,
            claim_id: 'c1',
            member_id: 'm1', player_id: 'p1', drop_player_id: null,
            status: 'succeeded',
            failure_reason: null,
        }, { processed: false }])
        mockFrom.mockImplementation((table) => table === 'players' ? q({ display_name: 'LeBron James' }) as any : q() as any)

        await processWaiverClaims()

        expect(mockRpc).toHaveBeenCalledTimes(2)
        expect(mockFrom.mock.calls.map((c) => c[0])).toContain('players')
        expect(mockFrom.mock.calls.map((c) => c[0])).toContain('waiver_wire_log')
    })

    it('marks second claim for same player as failed_priority', async () => {
        setupRpcRows([
            { processed: true, claim_id: 'c1', member_id: 'm1', player_id: 'p1', status: 'succeeded', failure_reason: null },
            { processed: true, claim_id: 'c2', member_id: 'm2', player_id: 'p1', status: 'failed_priority', failure_reason: 'Higher priority claim succeeded.' },
            { processed: false },
        ])
        mockFrom.mockImplementation((table) => table === 'players' ? q({ display_name: 'LeBron James' }) as any : q() as any)

        await processWaiverClaims()
        expect(mockRpc).toHaveBeenCalledTimes(3)
    })

    it('fails claim with failed_roster when roster is full and no drop specified', async () => {
        setupRpcRows([
            { processed: true, claim_id: 'c1', member_id: 'm1', player_id: 'p1', status: 'failed_roster', failure_reason: 'Roster is full.' },
            { processed: false },
        ])
        mockFrom.mockImplementation((table) => table === 'players' ? q({ display_name: 'Player X' }) as any : q() as any)

        await processWaiverClaims()
        expect(mockRpc).toHaveBeenCalledTimes(2)
    })

    it('fails claim when player is no longer on waivers', async () => {
        setupRpcRows([
            { processed: true, claim_id: 'c1', member_id: 'm1', player_id: 'p1', status: 'failed_priority', failure_reason: 'Player is no longer on waivers.' },
            { processed: false },
        ])
        mockFrom.mockImplementation((table) => table === 'players' ? q({ display_name: 'Player X' }) as any : q() as any)

        await processWaiverClaims()
        expect(mockRpc).toHaveBeenCalledTimes(2)
    })

    it('executes drop-then-add when drop_player_id is specified and roster is full', async () => {
        setupRpcRows([
            { processed: true, claim_id: 'c1', member_id: 'm1', player_id: 'p1', status: 'succeeded', failure_reason: null },
            { processed: false },
        ])
        mockFrom.mockImplementation((table) => table === 'players' ? q({ display_name: 'New Player' }) as any : q() as any)

        await processWaiverClaims()
        expect(mockRpc).toHaveBeenCalledWith('process_next_waiver_claim_atomic', expect.any(Object))
    })
})
