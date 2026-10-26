import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'

const mocks = vi.hoisted(() => ({
    requestTradeEstimate: vi.fn(),
}))

vi.mock('@/lib/trade-estimates', () => ({ requestTradeEstimate: mocks.requestTradeEstimate }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => true }))
vi.mock('@/contexts/panel-activity', () => ({ usePanelActivity: () => true }))
vi.mock('@/lib/league-changes', () => ({ deferLeagueRefresh: () => ({ trigger: vi.fn(), cancel: vi.fn() }), listenForLeagueChanges: () => () => {} }))
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = {
    player_id: 'player-1', display_name: 'Player One', age: 24, five_year_rank: 8,
    rank_change: 1, injury_status: null, avg_fantasy_points: 42,
    projection_fantasy_points: 44, years_exp: 3, ranking_source: 'rankings',
    ranking_fetched_at: null, projection_source: 'projections', projection_fetched_at: null,
}

const baseInput = {
    enabled: true,
    leagueId: 'league-a',
    memberId: 'member-a',
    scoringSettings: { points: 1 },
    teams: 12,
    faabBudget: 100,
    participants: [
        { memberId: 'member-a', roster: [{ players: { id: 'player-1', display_name: 'Player One' } }], picks: [] },
        { memberId: 'member-b', roster: [], picks: [] },
    ],
    items: [{ kind: 'player' as const, fromMemberId: 'member-a', toMemberId: 'member-b', playerId: 'player-1' }],
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    mocks.requestTradeEstimate.mockResolvedValue({ id: 'quote', seasonYear: 2042, expiresAt: new Date(Date.now()+600000).toISOString(), analysis: { assets: [row] } })
})

afterEach(() => { vi.useRealTimers() })

it('coalesces rapid player changes into one forecast request after 300 ms', async () => {
    let renderer!: ReactTestRenderer
    let latest!: ReturnType<typeof useDynastyTradeAnalysis>
    const Probe = ({ playerId }: { playerId: string }) => {
        latest = useDynastyTradeAnalysis({ ...baseInput, debounceMs: 300,
            items: [{ ...baseInput.items[0], playerId }],
        } as unknown as Parameters<typeof useDynastyTradeAnalysis>[0])
        return null
    }
    await act(async () => { renderer = create(React.createElement(Probe, { playerId: 'player-1' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    await act(async () => { renderer.update(React.createElement(Probe, { playerId: 'player-2' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(mocks.requestTradeEstimate).not.toHaveBeenCalled()
    expect(latest.analysis).toBeNull()
    expect(latest.loading).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(mocks.requestTradeEstimate).toHaveBeenCalledExactlyOnceWith('member-a', [expect.objectContaining({ playerId: 'player-2' })])
    await act(async () => { renderer.unmount() })
})

it('cancels a delayed forecast when the analyzer closes', async () => {
    let renderer!: ReactTestRenderer
    const Probe = () => { useDynastyTradeAnalysis({ ...baseInput, debounceMs: 300 } as unknown as Parameters<typeof useDynastyTradeAnalysis>[0]); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { renderer.unmount() })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(mocks.requestTradeEstimate).not.toHaveBeenCalled()
})
