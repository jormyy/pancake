import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('../src/config', () => ({ CONFIG: { ROOKIE_DRAFT_ROUNDS: 3 } }))

import { supabase } from '../src/lib/supabase'
import { makeSnakePick, autoPickBest, startRookieDraft } from '../src/sync/rookieDraft'

const mockFrom = vi.mocked(supabase.from)

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

// ── makeSnakePick ─────────────────────────────────────────────────────────────

describe('makeSnakePick', () => {
    const inProgressDraft = { id: 'd1', league_id: 'lg1', league_season_id: 's1', status: 'in_progress' }
    const nextPickForM1 = { id: 'sp1', overall_pick: 5, round: 2, pick_in_round: 3, member_id: 'm1' }

    it('throws if draft is not in_progress', async () => {
        mockFrom.mockReturnValue(q({ ...inProgressDraft, status: 'completed' }) as any)
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow('not in progress')
    })

    it('throws if it is not the member\'s pick', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q(inProgressDraft) as any
            if (n === 2) return q({ ...nextPickForM1, member_id: 'm2' }) as any // m2's turn
            return q(null) as any
        })
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow("not your pick")
    })

    it('throws if player is already on a roster in this league', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q(inProgressDraft) as any
            if (n === 2) return q(nextPickForM1) as any
            if (n === 3) return q({ id: 'existing-rp' }) as any // already on roster
            return q(null) as any
        })
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow('already on a roster')
    })

    it('throws if player was already picked in this draft', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q(inProgressDraft) as any
            if (n === 2) return q(nextPickForM1) as any
            if (n === 3) return q(null) as any             // not on roster
            if (n === 4) return q({ id: 'prior-pick' }) as any // already picked
            return q(null) as any
        })
        await expect(makeSnakePick('d1', 'm1', 'p1')).rejects.toThrow('already picked')
    })

    it('returns rosterOverflow: true when active roster count exceeds roster_size', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q(inProgressDraft) as any
            if (n === 2) return q(nextPickForM1) as any
            if (n === 3) return q(null) as any  // not on roster
            if (n === 4) return q(null) as any  // not already picked
            if (n === 5) return q(null) as any  // update snake_draft_picks
            if (n === 6) return q(null) as any  // insert roster_players
            if (n === 7) return q(null) as any  // update draft_picks (mark used)
            if (n === 8) return q(null, null, 3) as any // remaining picks (not last)
            if (n === 9) return q({ roster_size: 20, taxi_slots: 2 }) as any
            if (n === 10) return q(null, null, 21) as any // activeCount = 21 (over limit)
            if (n === 11) return q(null, null, 1) as any  // taxiCount
            return q(null) as any
        })
        const result = await makeSnakePick('d1', 'm1', 'p1')
        expect(result.rosterOverflow).toBe(true)
    })

    it('returns rosterOverflow: false when within roster_size', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q(inProgressDraft) as any
            if (n === 2) return q(nextPickForM1) as any
            if (n === 3) return q(null) as any
            if (n === 4) return q(null) as any
            if (n === 5) return q(null) as any
            if (n === 6) return q(null) as any
            if (n === 7) return q(null) as any
            if (n === 8) return q(null, null, 5) as any
            if (n === 9) return q({ roster_size: 20, taxi_slots: 2 }) as any
            if (n === 10) return q(null, null, 15) as any // activeCount = 15 (within limit)
            if (n === 11) return q(null, null, 1) as any
            return q(null) as any
        })
        const result = await makeSnakePick('d1', 'm1', 'p1')
        expect(result.rosterOverflow).toBe(false)
    })

    it('returns taxiSlotsAvailable: true when below taxi limit', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q(inProgressDraft) as any
            if (n === 2) return q(nextPickForM1) as any
            if (n === 3) return q(null) as any
            if (n === 4) return q(null) as any
            if (n === 5) return q(null) as any
            if (n === 6) return q(null) as any
            if (n === 7) return q(null) as any
            if (n === 8) return q(null, null, 2) as any
            if (n === 9) return q({ roster_size: 20, taxi_slots: 3 }) as any
            if (n === 10) return q(null, null, 15) as any
            if (n === 11) return q(null, null, 2) as any // taxiCount = 2 (limit is 3 → available)
            return q(null) as any
        })
        const result = await makeSnakePick('d1', 'm1', 'p1')
        expect(result.taxiSlotsAvailable).toBe(true)
    })

    it('completes the draft and sets league to active when last pick is made', async () => {
        const updatedTables: string[] = []
        let n = 0
        mockFrom.mockImplementation((table: string) => {
            n++
            if (n === 1) return q(inProgressDraft) as any
            if (n === 2) return q(nextPickForM1) as any
            if (n === 3) return q(null) as any
            if (n === 4) return q(null) as any
            if (n === 5) return q(null) as any
            if (n === 6) return q(null) as any
            if (n === 7) return q(null) as any
            if (n === 8) return q(null, null, 0) as any // count = 0 → last pick
            // n=9: drafts update (completed), n=10: leagues update (active)
            if (n === 9 || n === 10) {
                updatedTables.push(table)
                return q(null) as any
            }
            if (n === 11) return q({ roster_size: 20, taxi_slots: 2 }) as any
            if (n === 12) return q(null, null, 15) as any
            if (n === 13) return q(null, null, 1) as any
            return q(null) as any
        })
        await makeSnakePick('d1', 'm1', 'p1')
        expect(updatedTables).toContain('drafts')
        expect(updatedTables).toContain('leagues')
    })
})

// ── autoPickBest ──────────────────────────────────────────────────────────────

describe('autoPickBest', () => {
    const inProgressDraft = { id: 'd1', league_id: 'lg1', league_season_id: 's1', status: 'in_progress' }
    const nextPickForM1 = { id: 'sp1', overall_pick: 3, round: 1, pick_in_round: 3, member_id: 'm1' }

    it('selects the player with the lowest available nba_draft_number', async () => {
        let n = 0
        const selectedPlayers: string[] = []
        mockFrom.mockImplementation((table: string) => {
            n++
            // autoPickBest calls (2 queries before delegating to makeSnakePick)
            if (n === 1) return q([{ player_id: 'p1' }]) as any  // already-picked ids
            if (n === 2) return q([{ id: 'p2' }, { id: 'p3' }]) as any // available sorted by draft#
            // makeSnakePick calls follow — p2 should be chosen (first available)
            if (n === 3) return q(inProgressDraft) as any
            if (n === 4) return q(nextPickForM1) as any
            if (n === 5) return q(null) as any
            if (n === 6) return q(null) as any
            if (n === 7) return q(null) as any
            if (n === 8) {
                selectedPlayers.push(table) // record that roster_players insert happened
                return q(null) as any
            }
            if (n === 9) return q(null) as any
            if (n === 10) return q(null, null, 2) as any
            if (n === 11) return q({ roster_size: 20, taxi_slots: 2 }) as any
            if (n === 12) return q(null, null, 15) as any
            if (n === 13) return q(null, null, 1) as any
            return q(null) as any
        })
        const result = await autoPickBest('d1', 'm1')
        // p1 was already picked → p2 should be selected (lowest available)
        expect(result.newPlayerId).toBe('p2')
    })

    it('skips players already picked in this draft', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q([{ player_id: 'p1' }, { player_id: 'p2' }]) as any // p1 & p2 picked
            if (n === 2) return q([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]) as any  // all available
            // makeSnakePick calls — p3 should be selected
            if (n === 3) return q({ id: 'd1', league_id: 'lg1', league_season_id: 's1', status: 'in_progress' }) as any
            if (n === 4) return q({ id: 'sp1', overall_pick: 5, round: 2, pick_in_round: 1, member_id: 'm1' }) as any
            if (n === 5) return q(null) as any
            if (n === 6) return q(null) as any
            if (n === 7) return q(null) as any
            if (n === 8) return q(null) as any
            if (n === 9) return q(null) as any
            if (n === 10) return q(null, null, 1) as any
            if (n === 11) return q({ roster_size: 20, taxi_slots: 2 }) as any
            if (n === 12) return q(null, null, 15) as any
            if (n === 13) return q(null, null, 1) as any
            return q(null) as any
        })
        const result = await autoPickBest('d1', 'm1')
        expect(result.newPlayerId).toBe('p3')
    })

    it('throws when no available rookies remain', async () => {
        let n = 0
        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q([{ player_id: 'p1' }, { player_id: 'p2' }]) as any
            if (n === 2) return q([{ id: 'p1' }, { id: 'p2' }]) as any // all players already picked
            return q(null) as any
        })
        await expect(autoPickBest('d1', 'm1')).rejects.toThrow('No available players')
    })
})

// ── startRookieDraft — traded pick accounting ─────────────────────────────────

describe('startRookieDraft — traded pick accounting', () => {
    it('assigns snake_draft_pick slot to current_owner_id when pick was traded', async () => {
        const insertedPicks: any[] = []
        let n = 0

        mockFrom.mockImplementation((table: string) => {
            n++
            if (n === 1) return q({ id: 'lg1', status: 'offseason' }) as any  // leagues select
            if (n === 2) return q({ id: 's1', season_year: 2026 }) as any      // league_seasons (current)
            if (n === 3) return q(null) as any                                  // drafts (no existing)
            if (n === 4) return q({ id: 'prev-s' }) as any                     // league_seasons (last)
            if (n === 5) return q([                                             // standings
                { member_id: 'm1', wins: 20, losses: 62, points_for: 900 },   // worst → slot 1
                { member_id: 'm2', wins: 62, losses: 20, points_for: 1800 },  // best  → slot 2
            ]) as any
            if (n === 6) {                                                      // drafts insert
                const chain: any = {
                    select: () => chain,
                    single: () => Promise.resolve({ data: { id: 'd1' }, error: null }),
                    insert: () => chain,
                    then: (res: any, rej: any) => Promise.resolve({ data: { id: 'd1' }, error: null }).then(res, rej),
                }
                return chain
            }
            if (n === 7) return q(null) as any                                  // draft_orders insert
            if (n === 8) return q([                                             // draft_picks (trade assets)
                // m1 traded their R1 pick to m2
                { season_year: 2026, round: 1, original_owner_id: 'm1', current_owner_id: 'm2' },
                // m2 keeps their R1 pick
                { season_year: 2026, round: 1, original_owner_id: 'm2', current_owner_id: 'm2' },
            ]) as any
            if (n === 9) {                                                      // snake_draft_picks insert
                return {
                    insert: (rows: any[]) => {
                        insertedPicks.push(...rows)
                        return Promise.resolve({ data: null, error: null })
                    },
                }
            }
            return q(null) as any                                               // leagues update
        })

        await startRookieDraft('lg1')

        // Draft order: m1 (worst) → slot 1, m2 (best) → slot 2
        // Round 1 (normal order): originalOwner[0]=m1, originalOwner[1]=m2
        // m1 traded R1 to m2 → pick_in_round=1 should belong to m2
        const r1p1 = insertedPicks.find((p: any) => p.round === 1 && p.pick_in_round === 1)
        expect(r1p1?.member_id).toBe('m2')
    })

    it('untouched picks retain their original owner', async () => {
        const insertedPicks: any[] = []
        let n = 0

        mockFrom.mockImplementation(() => {
            n++
            if (n === 1) return q({ id: 'lg1', status: 'offseason' }) as any
            if (n === 2) return q({ id: 's1', season_year: 2026 }) as any
            if (n === 3) return q(null) as any
            if (n === 4) return q({ id: 'prev-s' }) as any
            if (n === 5) return q([
                { member_id: 'm1', wins: 20, losses: 62, points_for: 900 },
                { member_id: 'm2', wins: 62, losses: 20, points_for: 1800 },
            ]) as any
            if (n === 6) {
                const chain: any = {
                    select: () => chain,
                    single: () => Promise.resolve({ data: { id: 'd1' }, error: null }),
                    insert: () => chain,
                    then: (res: any, rej: any) => Promise.resolve({ data: { id: 'd1' }, error: null }).then(res, rej),
                }
                return chain
            }
            if (n === 7) return q(null) as any
            if (n === 8) return q([]) as any  // no traded picks
            if (n === 9) {
                return {
                    insert: (rows: any[]) => {
                        insertedPicks.push(...rows)
                        return Promise.resolve({ data: null, error: null })
                    },
                }
            }
            return q(null) as any
        })

        await startRookieDraft('lg1')

        // With no trades, round 1 pick 1 goes to m1 (worst record, first in draft order)
        const r1p1 = insertedPicks.find((p: any) => p.round === 1 && p.pick_in_round === 1)
        expect(r1p1?.member_id).toBe('m1')

        // Round 2 is snake (reversed): pick 1 goes to m2
        const r2p1 = insertedPicks.find((p: any) => p.round === 2 && p.pick_in_round === 1)
        expect(r2p1?.member_id).toBe('m2')
    })
})
