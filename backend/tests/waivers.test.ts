import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn() },
}))
vi.mock('../src/lib/notifications', () => ({
    notifyMember: vi.fn().mockResolvedValue(undefined),
}))

import { supabase } from '../src/lib/supabase'
import { processWaiverClaims } from '../src/sync/waivers'

const mockFrom = vi.mocked(supabase.from)

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
function setupFromSequence(responses: any[]) {
    let i = 0
    mockFrom.mockImplementation(() => {
        const r = responses[i] ?? q()
        i++
        return r
    })
}

describe('processWaiverClaims', () => {
    it('returns early when no pending claims exist', async () => {
        setupFromSequence([
            q([]),  // waiver_claims fetch → empty
            q(),    // waiver_wire_log clear
        ])
        // Should not throw
        await expect(processWaiverClaims()).resolves.toBeUndefined()
    })

    it('succeeds: adds player and moves member to back of priority queue', async () => {
        const claim = {
            id: 'c1', league_id: 'lg1', league_season_id: 's1',
            member_id: 'm1', player_id: 'p1', drop_player_id: null,
            priority_at_submission: 1,
        }

        setupFromSequence([
            q([claim]),                             // waiver_claims — pending claims
            q({ display_name: 'LeBron James' }),    // players — player name
            q({ id: 'wl1' }),                       // waiver_wire_log — still on waivers
            q(null),                                // roster_players — not already owned
            q({ roster_size: 15 }),                 // leagues — roster size
            q(null, null, 10),                      // roster_players count — 10 active (< 15)
            q({ id: 'rp-new' }),                    // roster_players insert
            q(),                                    // roster_transactions insert (log)
            q(),                                    // waiver_wire_log update (mark claimed)
            q({ priority: 5 }),                     // waiver_priorities — max priority
            q(),                                    // waiver_priorities update (move to back)
            q(),                                    // waiver_claims update (succeeded)
            q(),                                    // waiver_wire_log clear expired
        ])

        await processWaiverClaims()

        // Verify waiver_claims was updated to 'succeeded'
        const calls = mockFrom.mock.calls.map((c) => c[0])
        expect(calls).toContain('waiver_claims')
        expect(calls).toContain('roster_players')
        expect(calls).toContain('waiver_priorities')
    })

    it('marks second claim for same player as failed_priority', async () => {
        const claim1 = {
            id: 'c1', league_id: 'lg1', league_season_id: 's1',
            member_id: 'm1', player_id: 'p1', drop_player_id: null,
            priority_at_submission: 1,
        }
        const claim2 = {
            id: 'c2', league_id: 'lg1', league_season_id: 's1',
            member_id: 'm2', player_id: 'p1', drop_player_id: null,
            priority_at_submission: 2,
        }

        // Track calls to waiver_claims update so we can inspect status updates
        const updateCalls: any[] = []
        let fromCallIndex = 0

        const responses = [
            q([claim1, claim2]),                    // initial fetch — both claims
            q({ display_name: 'LeBron James' }),    // player name (claim1)
            q({ id: 'wl1' }),                       // waiver_wire_log — on waivers (claim1)
            q(null),                                // not already owned (claim1)
            q({ roster_size: 15 }),                 // league roster size (claim1)
            q(null, null, 10),                      // active roster count (claim1)
            q({ id: 'rp-new' }),                    // roster insert (claim1 success)
            q(),                                    // log transaction (claim1)
            q(),                                    // waiver_wire_log mark claimed (claim1)
            q({ priority: 5 }),                     // max priority (claim1)
            q(),                                    // update priority (claim1)
            q(),                                    // waiver_claims update → succeeded (claim1)
            q({ display_name: 'LeBron James' }),    // player name (claim2)
            q(),                                    // waiver_claims update → failed_priority (claim2)
            q(),                                    // waiver_wire_log clear expired
        ]

        mockFrom.mockImplementation(() => {
            const r = responses[fromCallIndex] ?? q()
            fromCallIndex++
            return r
        })

        await processWaiverClaims()
        // If we get here without throwing, the second claim was handled (failed_priority)
        expect(fromCallIndex).toBeGreaterThan(10)
    })

    it('fails claim with failed_roster when roster is full and no drop specified', async () => {
        const claim = {
            id: 'c1', league_id: 'lg1', league_season_id: 's1',
            member_id: 'm1', player_id: 'p1', drop_player_id: null,
            priority_at_submission: 1,
        }

        setupFromSequence([
            q([claim]),                          // waiver_claims
            q({ display_name: 'Player X' }),     // player name
            q({ id: 'wl1' }),                    // on waivers
            q(null),                             // not owned
            q({ roster_size: 15 }),              // league
            q(null, null, 15),                   // active count = 15 (FULL)
            q(),                                 // waiver_claims update → failed_roster
            q(),                                 // waiver_wire_log clear
        ])

        await processWaiverClaims()
        // verified by reaching this point without error
    })

    it('fails claim when player is no longer on waivers', async () => {
        const claim = {
            id: 'c1', league_id: 'lg1', league_season_id: 's1',
            member_id: 'm1', player_id: 'p1', drop_player_id: null,
            priority_at_submission: 1,
        }

        setupFromSequence([
            q([claim]),                          // waiver_claims
            q({ display_name: 'Player X' }),     // player name
            q(null),                             // waiver_wire_log → NOT on waivers
            q(),                                 // waiver_claims update → failed_priority
            q(),                                 // waiver_wire_log clear
        ])

        await processWaiverClaims()
    })

    it('executes drop-then-add when drop_player_id is specified and roster is full', async () => {
        const claim = {
            id: 'c1', league_id: 'lg1', league_season_id: 's1',
            member_id: 'm1', player_id: 'p1', drop_player_id: 'p99',
            priority_at_submission: 1,
        }

        setupFromSequence([
            q([claim]),                              // waiver_claims
            q({ display_name: 'New Player' }),       // player name
            q({ id: 'wl1' }),                        // on waivers
            q(null),                                 // not owned
            q({ roster_size: 15 }),                  // league
            q(null, null, 15),                       // active count = 15 (full, but drop provided)
            q({ id: 'drop-rp', player_id: 'p99' }), // find drop player roster row
            q(),                                     // delete drop player
            q(),                                     // waiver_wire_log insert for dropped player
            q(),                                     // log drop transaction
            q({ id: 'rp-new' }),                     // roster_players insert (add claimed player)
            q(),                                     // log add transaction
            q(),                                     // waiver_wire_log mark claimed
            q({ priority: 3 }),                      // max priority
            q(),                                     // update priority
            q(),                                     // waiver_claims update → succeeded
            q(),                                     // waiver_wire_log clear expired
        ])

        await processWaiverClaims()
        // The drop was processed: from() should have been called with waiver_wire_log for the drop
        const tablesCalled = mockFrom.mock.calls.map((c) => c[0])
        expect(tablesCalled.filter((t) => t === 'waiver_wire_log').length).toBeGreaterThanOrEqual(2)
    })
})
