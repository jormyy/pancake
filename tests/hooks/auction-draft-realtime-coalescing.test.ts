import React from 'react'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))

const mocks = vi.hoisted(() => ({ state: vi.fn(), revision: vi.fn(), status: null as ((value: string) => void) | null, change: null as (() => void) | null }))
vi.mock('@/lib/cache/screen-cache', () => ({ readScreenView: (scope: { params: { draftId: string } }) => mocks.state(scope.params.draftId) }))
vi.mock('@/lib/league-version', () => ({ subscribeLeagueVersion: () => () => {} }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'league' } }) }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) } }))
vi.mock('@/lib/draft', () => ({
    getDraftState: mocks.state, getDraftPollRevision: mocks.revision, closeExpiredNominations: vi.fn(),
    nominatePlayer: vi.fn(), placeBid: vi.fn(), searchPlayers: vi.fn(), withdrawNomination: vi.fn(),
    subscribeToDraft: vi.fn((_id: string, _league: null, change: () => void, status: (value: string) => void) => { mocks.change = change; mocks.status = status; return {} }),
    unsubscribeFromDraft: vi.fn(async () => {}),
}))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ reportRealtimeCleanup: vi.fn() }))
setSessionOwner('draft-test-user')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
beforeEach(() => { vi.useFakeTimers(); mocks.state.mockReset().mockResolvedValue(draftState()) })
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.useRealTimers() })
function draftState(): DraftState {
    return {
        draft: {
            id: 'draft-1',
            leagueId: 'league-1',
            status: 'paused',
            draftType: 'auction',
            isMock: false,
            currentNominationOrder: 0,
            nominationOrderMode: 'user_nominated',
            budgetPerTeam: 200,
            scheduledAt: null,
            roomName: null,
            createdByMemberId: null,
            pickTimerSeconds: 30,
            timerExpiryBehavior: 'auction_no_bid',
            rounds: null,
            startedAt: null,
            pauseReason: 'member_absent',
            pausedAt: null,
            pausedRemainingSeconds: 10,
        },
        order: [{ position: 1, memberId: 'member-1', teamName: 'Team' }],
        budgets: [],
        nominations: [],
        activeBids: [],
        openNomination: null,
        currentNominatorMemberId: 'member-1',
    }
}

function Probe() {
    useAuctionDraftRoomController({ draftId: 'draft-1', memberId: 'member-1' })
    return null
}


it('coalesces a burst and refreshes at the first event deadline', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    mocks.state.mockClear()
    for (let index = 0; index < 10; index++) mocks.change!()
    expect(mocks.state).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(mocks.state).toHaveBeenCalledTimes(1)
})

it('cancels an admitted burst on teardown', async () => {
    await act(async () => { renderer = create(React.createElement(Probe)) })
    mocks.state.mockClear()
    mocks.change!()
    act(() => renderer!.unmount())
    renderer = undefined
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(mocks.state).not.toHaveBeenCalled()
})
