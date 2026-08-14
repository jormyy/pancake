import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'

// The debounce helper's own coalescing is covered in
// tests/lib/realtime-subscription.test.ts. What matters here is that the auction
// room routes realtime events through it instead of reloading per event: before
// this wiring, every bid insert in the league triggered a full draft-state
// reload on every connected client.
const mocks = vi.hoisted(() => ({
    getDraftState: vi.fn(),
    getDraftPollRevision: vi.fn(async () => 'revision-1'),
    changeCallback: null as (() => void) | null,
    debouncedTargets: [] as (() => void)[],
    flushAll: [] as (() => void)[],
    cancelled: 0,
}))

vi.mock('@/lib/draft', () => ({
    closeExpiredNominations: vi.fn(),
    getDraftState: mocks.getDraftState,
    getDraftPollRevision: mocks.getDraftPollRevision,
    nominatePlayer: vi.fn(),
    placeBid: vi.fn(),
    searchPlayers: vi.fn(async () => []),
    subscribeToDraft: vi.fn((
        _draftId: string,
        _leagueId: string | null,
        onChange: () => void,
    ) => {
        mocks.changeCallback = onChange
        return { topic: 'draft' }
    }),
    unsubscribeFromDraft: vi.fn(async () => undefined),
    withdrawNomination: vi.fn(),
}))
vi.mock('@/lib/alert', () => ({ getErrorMessage: String, showAlert: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    reportRealtimeCleanup: vi.fn(),
    debounceRealtimeRefresh: (onChange: () => void) => {
        mocks.debouncedTargets.push(onChange)
        let armed = false
        const debounced = {
            trigger: () => { armed = true },
            cancel: () => { armed = false; mocks.cancelled += 1 },
        }
        // Stands in for the timer firing, so a test can assert the coalesced
        // reload actually lands instead of only proving nothing ran.
        mocks.flushAll.push(() => { if (armed) { armed = false; onChange() } })
        return debounced
    },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('auction draft realtime coalescing', () => {
    let renderer: ReactTestRenderer | null = null

    beforeEach(() => {
        mocks.changeCallback = null
        mocks.debouncedTargets.length = 0
        mocks.flushAll.length = 0
        mocks.cancelled = 0
        mocks.getDraftState.mockReset()
        mocks.getDraftState.mockImplementation(async () => draftState())
    })

    afterEach(() => {
        act(() => { renderer?.unmount() })
        renderer = null
    })

    it('subscribes with a debounced handler rather than the raw loader', async () => {
        await act(async () => {
            renderer = create(React.createElement(Probe))
        })

        // One debouncer per subscription; the room resubscribes once the league
        // id resolves, so more than one construction is expected.
        expect(mocks.debouncedTargets.length).toBeGreaterThan(0)
        expect(mocks.changeCallback).toBeTypeOf('function')
        // The handler handed to the channel is the debouncer's trigger, never one
        // of the loaders it wraps.
        expect(mocks.debouncedTargets).not.toContain(mocks.changeCallback)
    })

    it('does not reload the draft state per realtime event', async () => {
        await act(async () => {
            renderer = create(React.createElement(Probe))
        })

        const loadsAfterMount = mocks.getDraftState.mock.calls.length

        await act(async () => {
            for (let i = 0; i < 10; i += 1) mocks.changeCallback?.()
        })

        expect(mocks.getDraftState.mock.calls.length).toBe(loadsAfterMount)

        // ...and the burst still produces exactly one reload once it settles.
        await act(async () => {
            for (const flush of mocks.flushAll) flush()
        })
        expect(mocks.getDraftState.mock.calls.length).toBe(loadsAfterMount + 1)
    })

    it('cancels the pending refresh when the room unmounts', async () => {
        await act(async () => {
            renderer = create(React.createElement(Probe))
        })
        act(() => { renderer?.unmount() })
        renderer = null

        expect(mocks.cancelled).toBeGreaterThan(0)
    })
})
