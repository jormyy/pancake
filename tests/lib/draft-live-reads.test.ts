import { beforeEach, expect, it, vi } from 'vitest'
import { searchPlayers } from '@/lib/draft'

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
