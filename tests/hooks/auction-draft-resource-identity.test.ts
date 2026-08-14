import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'

const mocks = vi.hoisted(() => ({
    getDraftState: vi.fn(),
    getDraftPollRevision: vi.fn(async () => 'revision-1'),
    placeBid: vi.fn(),
    statusCallback: null as ((status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => void) | null,
    unsubscribeFromDraft: vi.fn(async () => undefined),
}))

vi.mock('@/lib/draft', () => ({
    closeExpiredNominations: vi.fn(),
    getDraftState: mocks.getDraftState,
    getDraftPollRevision: mocks.getDraftPollRevision,
    nominatePlayer: vi.fn(),
    placeBid: mocks.placeBid,
    searchPlayers: vi.fn(async () => []),
    subscribeToDraft: vi.fn((
        _draftId: string,
        _leagueId: string | null,
        _onChange: () => void,
        onStatus: typeof mocks.statusCallback,
    ) => {
        mocks.statusCallback = onStatus
        return { topic: 'draft' }
    }),
    unsubscribeFromDraft: mocks.unsubscribeFromDraft,
    withdrawNomination: vi.fn(),
}))
vi.mock('@/lib/alert', () => ({ getErrorMessage: String, showAlert: vi.fn() }))
// Pass-through debounce: these cases assert loader identity and fail-closed
// behavior, not coalescing. Burst coalescing is covered in
// tests/hooks/auction-draft-realtime-coalescing.test.ts against the real helper.
vi.mock('@/lib/realtime', () => ({
    reportRealtimeCleanup: vi.fn(),
    debounceRealtimeRefresh: (onChange: () => void) => ({ trigger: onChange, cancel: () => {} }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function state(draftId: string): DraftState {
    return {
        draft: {
            id: draftId,
            leagueId: `league-${draftId}`,
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
        order: [{ position: 1, memberId: 'member', teamName: 'Team' }],
        budgets: [],
        nominations: [],
        activeBids: [],
        openNomination: null,
        currentNominatorMemberId: 'member',
    }
}

function liveState(draftId: string): DraftState {
    const base = state(draftId)
    const openNomination = {
        id: `nomination-${draftId}`,
        status: 'open' as const,
        nominatingMemberId: 'member',
        currentBidAmount: 1,
        currentBidderId: null,
        countdownExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        winningMemberId: null,
        finalPrice: null,
        nominatedAt: new Date().toISOString(),
        nominationOrder: 1,
        player: { displayName: 'Player', nbaTeam: 'LAL', position: 'PG', nbaId: null, age: 22 },
    }
    return { ...base, openNomination, nominations: [openNomination], draft: { ...base.draft, status: 'in_progress' } }
}

afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.statusCallback = null
})

describe('auction draft resource identity', () => {
    it('fails closed on channel failure and recovers only after subscription', async () => {
        mocks.getDraftState.mockResolvedValue(state('draft-a'))
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        const Probe = () => {
            latest = useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => {
            mocks.statusCallback?.('CHANNEL_ERROR')
        })
        expect(latest.realtimeConnected).toBe(false)
        expect(latest.loadError).toBe('Live draft connection lost. Tap to retry.')
        await act(async () => {
            mocks.statusCallback?.('SUBSCRIBED')
        })
        expect(latest.realtimeConnected).toBe(true)
        expect(latest.loadError).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('clears the previous draft while the next draft is loading', async () => {
        let resolveNext!: (value: DraftState) => void
        const next = new Promise<DraftState>((resolve) => { resolveNext = resolve })
        mocks.getDraftState.mockResolvedValueOnce(state('draft-a')).mockReturnValue(next)
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        const snapshots: { requested: string; visible?: string }[] = []
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useAuctionDraftRoomController({ draftId, memberId: 'member' })
            snapshots.push({ requested: draftId, visible: latest.state?.draft.id })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'draft-a' })); await Promise.resolve() })
        expect(latest.state?.draft.id).toBe('draft-a')
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-b' })) })
        expect(snapshots.find((snapshot) => snapshot.requested === 'draft-b')).toEqual({
            requested: 'draft-b',
            visible: undefined,
        })
        expect(latest.state).toBeNull()
        await act(async () => { resolveNext(state('draft-b')); await next })
        expect(latest.state?.draft.id).toBe('draft-b')
        await act(async () => { renderer.unmount() })
    })

    it('does not let an old draft mutation re-enter the loader after identity changes', async () => {
        let resolveBid!: () => void
        const bid = new Promise<void>((resolve) => { resolveBid = resolve })
        mocks.placeBid.mockReturnValue(bid)
        mocks.getDraftState.mockImplementation(async (draftId: string) =>
            draftId === 'draft-a' ? liveState(draftId) : state(draftId))
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useAuctionDraftRoomController({ draftId, memberId: 'member' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'draft-a' })); await Promise.resolve() })
        await act(async () => {
            mocks.statusCallback?.('SUBSCRIBED')
        })
        let pending!: Promise<void>
        await act(async () => { pending = latest.handleBid(); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-b' })); await Promise.resolve() })
        const readsAfterSwitch = mocks.getDraftState.mock.calls.length
        await act(async () => { resolveBid(); await pending })

        expect(mocks.getDraftState).toHaveBeenCalledTimes(readsAfterSwitch)
        expect(latest.state?.draft.id).toBe('draft-b')
        expect(latest.bidding).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('fails closed until the draft subscription is live', async () => {
        mocks.getDraftState.mockResolvedValue(liveState('draft-a'))
        const Probe = () => {
            latest = useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' })
            return null
        }
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })

        await act(async () => { await latest.handleBid() })
        expect(mocks.placeBid).not.toHaveBeenCalled()
        expect(latest.realtimeConnected).toBe(false)

        await act(async () => {
            mocks.statusCallback?.('SUBSCRIBED')
        })
        expect(latest.realtimeConnected).toBe(true)
        await act(async () => { mocks.statusCallback?.('TIMED_OUT') })
        expect(latest.realtimeConnected).toBe(false)
        expect(latest.loadError).toBe('Live draft connection lost. Tap to retry.')
        await act(async () => { renderer.unmount() })
    })
})
