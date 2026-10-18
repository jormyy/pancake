import { beforeEach, expect, it, vi } from 'vitest'
import { getDraftState, type DraftState } from '@/lib/draft'

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
    countdown_expires_at: '2026-10-18T12:01:00Z', winning_member_id: null, final_price: null,
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
            select: vi.fn(() => chain), eq: vi.fn(() => chain), order: vi.fn(() => chain),
            limit: vi.fn(() => chain), in: vi.fn(() => chain), not: vi.fn(() => chain),
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
