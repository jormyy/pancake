import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'

const { getPendingIncomingTradeCount, league } = vi.hoisted(() => ({
    getPendingIncomingTradeCount: vi.fn(),
    league: { value: { current: { id: 'member-a' }, currentLeague: { id: 'league-a' } } },
}))

vi.mock('expo-router', () => ({ usePathname: () => '/' }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => league.value }))
vi.mock('@/lib/trades', () => ({ getPendingIncomingTradeCount }))
vi.mock('@/lib/realtime', () => ({
    reportRealtimeCleanup: vi.fn(),
    subscribeToTableChanges: vi.fn(() => ({})),
    unsubscribeFromTableChanges: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const COUNTS: Record<string, number> = { 'league-a': 3, 'league-b': 5 }

beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    league.value = { current: { id: 'member-a' }, currentLeague: { id: 'league-a' } }
    getPendingIncomingTradeCount.mockImplementation(async (_member: string, leagueId: string) => COUNTS[leagueId])
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('usePendingTradeCount', () => {
    it('shows only the current league count and retries a failed read', async () => {
        let latest = -1
        const Probe = ({ leagueId }: { leagueId: string }) => {
            league.value = { current: { id: `member-${leagueId}` }, currentLeague: { id: leagueId } }
            latest = usePendingTradeCount()
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })) })
        expect(latest).toBe(3)

        // The first read for the next league fails, like a dropped request.
        getPendingIncomingTradeCount.mockRejectedValueOnce(new Error('network'))
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })) })
        expect(latest).toBe(0)

        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        expect(latest).toBe(5)
        await act(async () => { renderer.unmount() })
    })
})
