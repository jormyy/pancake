import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'
import { setSessionOwner } from '@/lib/session-cache-registry'
import type { DraftState } from '@/lib/draft'
import type { RookieDraftState } from '@/lib/rookieDraft'

const runtime = vi.hoisted(() => ({
    state: 'active', listeners: new Set<(state: string) => void>(), auction: vi.fn(), rookie: vi.fn(),
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('react-native', () => ({ AppState: {
    get currentState() { return runtime.state },
    addEventListener: (_: string, listener: (state: string) => void) => {
        runtime.listeners.add(listener)
        return { remove: () => runtime.listeners.delete(listener) }
    },
} }))
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))
vi.mock('@/lib/draft', () => ({
    getDraftState: runtime.auction, getDraftPollRevision: vi.fn(async () => 'stable'),
    subscribeToDraft: vi.fn(() => ({})), unsubscribeFromDraft: vi.fn(async () => {}),
    closeExpiredNominations: vi.fn(), nominatePlayer: vi.fn(), placeBid: vi.fn(), searchPlayers: vi.fn(), withdrawNomination: vi.fn(),
}))
vi.mock('@/lib/rookieDraft', () => ({
    getRookieDraftState: runtime.rookie, getRookieDraftPollRevision: vi.fn(async () => 'stable'), getRookiePlayers: vi.fn(async () => []),
    subscribeToRookieDraft: vi.fn(() => ({})), unsubscribeFromRookieDraft: vi.fn(async () => {}),
    activateRookieDraftLeague: vi.fn(), commissionerSnakePick: vi.fn(), makeSnakePick: vi.fn(), processExpiredSnakePick: vi.fn(),
}))
vi.mock('@/lib/roster', () => ({ dropPlayer: vi.fn(), getRoster: vi.fn(async () => []) }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ reportRealtimeCleanup: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
let auction: ReturnType<typeof useAuctionDraftRoomController>
let rookie: ReturnType<typeof useRookieDraftRoomController>
let renders = 0
const Probe = () => {
    auction = useAuctionDraftRoomController({ draftId: 'auction', memberId: 'member' })
    rookie = useRookieDraftRoomController({ draftId: 'rookie', memberId: 'member', leagueId: 'league', rosterSize: 20 })
    renders += 1
    return null
}
async function transition(state: string) {
    await act(async () => {
        runtime.state = state
        for (const listener of runtime.listeners) listener(state)
    })
}
beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    setSessionOwner('manager')
    runtime.state = 'active'
    runtime.listeners.clear()
    renders = 0
    const deadline = new Date(Date.now() + 60_000).toISOString()
    runtime.auction.mockResolvedValue({
        draft: {
            id: 'auction', leagueId: 'league', status: 'in_progress', draftType: 'auction', isMock: false,
            currentNominationOrder: 1, nominationOrderMode: 'user_nominated', budgetPerTeam: 200, scheduledAt: null,
            roomName: null, createdByMemberId: null, pickTimerSeconds: 60, timerExpiryBehavior: 'auction_no_bid',
            rounds: null, startedAt: null, pauseReason: null, pausedAt: null, pausedRemainingSeconds: null,
        },
        order: [], budgets: [], nominations: [], activeBids: [], currentNominatorMemberId: 'member',
        openNomination: {
            id: 'nomination', status: 'open', nominatingMemberId: 'member', currentBidAmount: 1, currentBidderId: null,
            countdownExpiresAt: deadline, winningMemberId: null, finalPrice: null, nominatedAt: '', nominationOrder: 1, player: null,
        },
    } satisfies DraftState)
    runtime.rookie.mockResolvedValue({
        draft: {
            id: 'rookie', leagueId: 'league', leagueSeasonId: 'season', isCurrentSeason: true,
            status: 'in_progress', isMock: false, pickTimerSeconds: 60, timerExpiryBehavior: 'skip_pick', rounds: 3,
            startedAt: null, completedAt: null, pauseReason: null, pausedAt: null, pausedRemainingSeconds: null,
        },
        picks: [], orders: [], nextPick: {
            overallPick: 1, round: 1, pickInRound: 1, memberId: 'other', teamName: 'Other team',
            pickedAt: null, skippedAt: null, skipReason: null, timerExpiresAt: deadline, player: null,
        },
    } satisfies RookieDraftState)
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })

it('keeps countdown values and renders unchanged while the app is hidden, then catches up', async () => {
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(auction.timeLeft).toBe(60)
    expect(rookie.secondsLeft).toBe(60)
    await transition('background')
    const hiddenRenders = renders
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(auction.timeLeft).toBe(60)
    expect(rookie.secondsLeft).toBe(60)
    expect(renders).toBe(hiddenRenders)
    await transition('active')
    expect(auction.timeLeft).toBe(55)
    expect(rookie.secondsLeft).toBe(55)
})

it('uses one-second display ticks for both draft clocks', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    await act(async () => { screen = create(React.createElement(Probe)) })
    expect(intervals.mock.calls.filter(([, delay]) => Number(delay) < 1_000)).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(auction.timeLeft).toBe(59)
    expect(rookie.secondsLeft).toBe(59)
    intervals.mockRestore()
})
