import { beforeEach, expect, it, vi } from 'vitest'
import { getDraftState, getDraftPollRevision, searchPlayers, type DraftState } from '@/lib/draft'

const boundary = vi.hoisted(() => ({ from: vi.fn(), tables: [] as string[], filters: [] as unknown[][] }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: boundary.from } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))

const draft = {
    id: 'draft', league_id: 'league', status: 'in_progress', draft_type: 'auction', is_mock: false,
    current_nomination_order: 3, nomination_order_mode: 'user_nominated', budget_per_team: 200,
    scheduled_at: null, room_name: null, created_by_member_id: null, pick_timer_seconds: 30,
    timer_expiry_behavior: 'auction_no_bid', rounds: null, started_at: null, pause_reason: null,
    paused_at: null, timer_paused_remaining_seconds: null,
}
const nomination = {
    id: 'nomination', status: 'open', current_bid_amount: 2, current_bidder_id: 'member', current_bid_to_taxi: false,
    countdown_expires_at: '2026-10-18T12:01:00Z', closed_at: null, winning_member_id: null, final_price: null,
    nominating_member_id: 'member', nominated_at: '2026-10-18T12:00:00Z', nomination_order: 3,
    player_id: 'player', players: { display_name: 'Player', nba_team: 'LAL', position: 'PG', nba_id: '1' },
}
let rows: Record<string, unknown[]>

beforeEach(() => {
    boundary.tables = []; boundary.filters = []; boundary.from.mockReset()
    rows = {
        drafts: [{ ...draft }], nominations: [{ ...nomination }],
        draft_orders: [{ position: 1, member_id: 'member', league_members: { team_name: 'Mine' } }],
        draft_budgets: [{ member_id: 'member', remaining: 190, initial_budget: 200, league_members: { team_name: 'Mine' } }],
        dynasty_rankings: [{ player_id: 'player', age: 25, fetched_at: '2026-10-18' }],
        bids: [{ id: 'bid-2', nomination_id: 'nomination', member_id: 'member', amount: 2, placed_at: '2026-10-18T12:00:01Z', league_members: { team_name: 'Mine' } }],
    }
    boundary.from.mockImplementation((table: string) => {
        boundary.tables.push(table)
        const chain = {
            select: vi.fn(() => chain), eq: vi.fn((...args: unknown[]) => { boundary.filters.push([table, 'eq', ...args]); return chain }), order: vi.fn(() => chain),
            limit: vi.fn(() => chain),
            in: vi.fn((...args: unknown[]) => { boundary.filters.push([table, 'in', ...args]); return chain }),
            not: vi.fn((...args: unknown[]) => { boundary.filters.push([table, 'not', ...args]); return chain }),
            is: vi.fn((...args: unknown[]) => { boundary.filters.push([table, 'is', ...args]); return chain }),
            ilike: vi.fn(() => chain),
            gt: vi.fn((...args: unknown[]) => { boundary.filters.push([table, ...args]); return chain }),
            maybeSingle: async () => ({ data: rows[table][0] ?? null, error: null }),
            then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: rows[table], error: null }).then(resolve),
        }
        return chain
    })
})

async function initial(): Promise<DraftState> {
    const state = (await getDraftState('draft'))!
    state.openNomination!.currentBidAmount = 1
    state.activeBids = [{ id: 'bid-1', nominationId: 'nomination', memberId: 'other', teamName: 'Other', amount: 1, placedAt: '2026-10-18T12:00:00Z' }]
    boundary.tables = []
    return state
}

it('reads the current bid and authoritative budgets without repeating history, order, or ages', async () => {
    const previous = await initial()
    const state = (await getDraftState('draft', previous))!
    expect(boundary.tables).toEqual(['drafts', 'nominations', 'draft_budgets', 'bids'])
    expect(boundary.filters).toContainEqual(['bids', 'amount', 1])
    expect(state.openNomination?.currentBidAmount).toBe(2)
    expect(state.openNomination?.player?.age).toBe(25)
    expect(state.activeBids.map(bid => bid.id)).toEqual(['bid-2', 'bid-1'])
    expect(state.budgets[0].remaining).toBe(190)
    expect(previous.openNomination?.currentBidAmount).toBe(1)
})

it('refreshes settled history and budgets when the current nomination closes', async () => {
    const previous = await initial()
    rows.nominations = [{ ...nomination, status: 'sold', winning_member_id: 'member', final_price: 2 }]
    const state = (await getDraftState('draft', previous))!
    expect(state.openNomination).toBeNull()
    expect(state.nominations[0].status).toBe('sold')
    expect(state.nominations[0].winningMemberId).toBe('member')
    expect(boundary.tables).toContain('draft_orders')
    expect(boundary.tables).toContain('dynasty_rankings')
})

it('uses full authority when no previous snapshot is supplied for reconnect', async () => {
    await initial()
    await getDraftState('draft')
    expect(boundary.tables).toContain('draft_orders')
    expect(boundary.tables).toContain('dynasty_rankings')
})

it('does not redownload bids after an unchanged notification', async () => {
    const previous = await initial()
    const updated = (await getDraftState('draft', previous))!
    boundary.tables = []
    const unchanged = (await getDraftState('draft', updated))!
    expect(boundary.tables).toEqual(['drafts', 'nominations', 'draft_budgets'])
    expect(unchanged.activeBids).toEqual(updated.activeBids)
})

it('rebuilds history when a different nomination replaces the open player', async () => {
    const previous = await initial()
    rows.nominations = [{ ...nomination, id: 'new-nomination' }]
    const state = (await getDraftState('draft', previous))!
    expect(state.openNomination?.id).toBe('new-nomination')
    expect(boundary.tables).toContain('draft_orders')
    expect(boundary.tables).toContain('dynasty_rankings')
})

it('never reuses another room snapshot', async () => {
    const previous = await initial()
    previous.draft.id = 'other-draft'
    await getDraftState('draft', previous)
    expect(boundary.tables).toContain('draft_orders')
    expect(boundary.tables).toContain('dynasty_rankings')
})

it('loads ages for 500 nominations using requests of at most 100 ids', async () => {
    rows.nominations = Array.from({ length: 500 }, (_, index) => ({
        ...nomination, id: `nomination-${index}`, player_id: `player-${index}`, status: 'sold', nomination_order: index + 1,
    })).reverse()
    rows.dynasty_rankings = Array.from({ length: 500 }, (_, index) => ({ player_id: `player-${index}`, age: index + 20 }))
    const state = (await getDraftState('draft'))!
    const ageQueries = boundary.filters.filter(([table, operation]) => table === 'dynasty_rankings' && operation === 'in')
    expect(ageQueries).toHaveLength(5)
    expect(ageQueries.every(([, , , ids]) => (ids as string[]).length <= 100)).toBe(true)
    expect(state.nominations).toHaveLength(500)
    expect(state.nominations[499].player?.age).toBe(519)
})

it('excludes prior nominations on the server without sending their ids in search requests', async () => {
    rows.nominations = Array.from({ length: 500 }, (_, index) => ({ player_id: `nominated-${index}` }))
    rows.players = [{ id: 'available', display_name: 'Available', dynasty_rank: 1 }]
    rows.dynasty_rankings = [{ player_id: 'available', age: 21 }]
    const found = await searchPlayers('Available', 'draft')
    expect(found).toMatchObject([{ id: 'available', age: 21 }])
    expect(boundary.tables).not.toContain('nominations')
    expect(boundary.filters).toContainEqual(['players', 'eq', 'nominated.draft_id', 'draft'])
    expect(boundary.filters).toContainEqual(['players', 'is', 'nominated', null])
    expect(boundary.filters.some(([table, operation]) => table === 'players' && operation === 'not')).toBe(false)
})

it('binds full and incremental reads to the revision used by the fallback poll', async () => {
    const state = (await getDraftState('draft'))!
    expect(state.pollRevision).toBe(await getDraftPollRevision('draft'))
    rows.nominations = [{ ...nomination, current_bid_amount: 4 }]
    const updated = (await getDraftState('draft', state))!
    expect(updated.pollRevision).toBe(await getDraftPollRevision('draft'))
    expect(updated.pollRevision).not.toBe(state.pollRevision)
})
