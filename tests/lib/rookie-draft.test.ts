import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from, removeChannel: vi.fn() } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ subscribeToTableChanges: vi.fn(), unsubscribeFromTableChanges: vi.fn() }))

import { getRookieDraftPollRevision, getRookieDraftState, getRookiePlayers } from '@/lib/rookieDraft'

function query(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> & PromiseLike<typeof result> = {
        then: (resolve) => Promise.resolve(result).then(resolve),
    }
    for (const method of ['select', 'eq', 'is', 'not', 'order', 'limit', 'ilike']) {
        chain[method] = vi.fn(() => chain)
    }
    chain.single = vi.fn(async () => result)
    chain.maybeSingle = vi.fn(async () => result)
    return chain
}

beforeEach(() => vi.clearAllMocks())

describe('rookie draft reads', () => {
    it('polls a constant-size draft revision without reading the full board', async () => {
        const draft = query({ data: { status: 'in_progress' }, error: null })
        const nextPick = query({ data: { overall_pick: 12, player_id: null }, error: null })
        mocks.from.mockImplementation((table: string) => table === 'drafts' ? draft : nextPick)

        const revision = await getRookieDraftPollRevision('draft')

        expect(revision).toContain('in_progress')
        expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(['drafts', 'snake_draft_picks'])
        expect(nextPick.is).toHaveBeenNthCalledWith(1, 'player_id', null)
        expect(nextPick.is).toHaveBeenNthCalledWith(2, 'skipped_at', null)
        expect(nextPick.order).toHaveBeenCalledWith('overall_pick', { ascending: true })
        expect(nextPick.limit).toHaveBeenCalledWith(1)
        expect(mocks.from).not.toHaveBeenCalledWith('draft_orders')
        expect(mocks.from).not.toHaveBeenCalledWith('players')
    })

    it.each(['drafts', 'snake_draft_picks', 'draft_orders'])('rejects when the %s board query fails', async (failedTable) => {
        mocks.from.mockImplementation((table: string) => query(table === failedTable
            ? { data: null, error: new Error(`${table} unavailable`) }
            : table === 'drafts'
                ? { data: { id: 'draft', league_id: 'league', status: 'in_progress', is_mock: false, pick_timer_seconds: 60, timer_expiry_behavior: 'auto_pick', rounds: 3, started_at: null, completed_at: null, pause_reason: null, paused_at: null, timer_paused_remaining_seconds: null }, error: null }
                : { data: [], error: null }))

        await expect(getRookieDraftState('draft')).rejects.toThrow(`${failedTable} unavailable`)
    })

    it('rejects prospect loading when picked-player identity cannot be read', async () => {
        mocks.from.mockImplementation((table: string) => query(table === 'snake_draft_picks'
            ? { data: null, error: new Error('picked ids unavailable') }
            : { data: [], error: null }))

        await expect(getRookiePlayers('draft')).rejects.toThrow('picked ids unavailable')
        expect(mocks.from).not.toHaveBeenCalledWith('players')
    })
})
