import React from 'react'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'

const mocks = vi.hoisted(() => ({
    getDraftState: vi.fn(),
    getDraftPollRevision: vi.fn(async () => 'revision-1'),
    placeBid: vi.fn(),
    closeExpiredNominations: vi.fn(),
    appState: 'active',
    reconnectCallback: null as null | (() => Promise<boolean>),
    statusCallback: null as ((status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => void) | null,
    unsubscribeFromDraft: vi.fn(async () => undefined),
}))

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('react-native', () => ({
    AppState: { get currentState() { return mocks.appState }, addEventListener: () => ({ remove: vi.fn() }) },
}))

vi.mock('@/lib/draft', () => ({
    closeExpiredNominations: mocks.closeExpiredNominations,
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
        onReconnect: () => Promise<boolean>,
    ) => {
        mocks.reconnectCallback = onReconnect
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

setSessionOwner('draft-test-user')

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
    mocks.appState = 'active'
})

describe('auction draft resource identity', () => {
    it('fails closed until subscription and authoritative recovery both finish', async () => {
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
        expect(latest.realtimeConnected).toBe(false)
        await act(async () => { await mocks.reconnectCallback?.() })
        expect(latest.realtimeConnected).toBe(true)
        expect(latest.loadError).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('builds a new live channel after CLOSED so bids and nominations can resume', async () => {
        vi.useFakeTimers()
        mocks.getDraftState.mockResolvedValue(state('draft-a'))
        const { subscribeToDraft } = await import('@/lib/draft')
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        const Probe = () => {
            latest = useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => { mocks.statusCallback?.('SUBSCRIBED') })
        expect(latest.realtimeConnected).toBe(true)
        const subscribed = vi.mocked(subscribeToDraft).mock.calls.length
        const removed = mocks.unsubscribeFromDraft.mock.calls.length

        await act(async () => { mocks.statusCallback?.('CLOSED') })
        expect(latest.realtimeConnected).toBe(false)
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
        expect(subscribeToDraft).toHaveBeenCalledTimes(subscribed + 1)
        expect(mocks.unsubscribeFromDraft).toHaveBeenCalledTimes(removed + 1)
        await act(async () => { mocks.statusCallback?.('SUBSCRIBED') })
        expect(latest.realtimeConnected).toBe(true)
        expect(latest.loadError).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('rebuilds a closed live channel when the user taps retry', async () => {
        mocks.getDraftState.mockResolvedValue(state('draft-a'))
        const { subscribeToDraft } = await import('@/lib/draft')
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        const Probe = () => {
            latest = useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => { mocks.statusCallback?.('CLOSED') })
        expect(latest.loadError).toBe('Live draft connection lost. Tap to retry.')
        const subscribed = vi.mocked(subscribeToDraft).mock.calls.length
        await act(async () => { await latest.refresh() })
        expect(subscribeToDraft).toHaveBeenCalledTimes(subscribed + 1)
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


describe('auction settlement requests', () => {
    it('holds a bid through its authoritative refresh and blocks same-render duplicate submissions', async () => {
        let resolveRead!: (value: DraftState) => void
        let hold = false
        mocks.getDraftState.mockImplementation(async () => hold
            ? new Promise<DraftState>(resolve => { resolveRead = resolve })
            : liveState('draft-a'))
        mocks.placeBid.mockResolvedValue(undefined)
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        const Probe = () => { latest = useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { mocks.statusCallback?.('SUBSCRIBED'); latest.setBidText('2') })
        hold = true
        const submit = latest.handleBid
        let first!: Promise<void>
        await act(async () => { first = submit(); void submit() })
        const busyDuringRead = latest.bidding
        const writes = mocks.placeBid.mock.calls.length
        const updated = liveState('draft-a')
        updated.openNomination!.currentBidAmount = 2
        await act(async () => { resolveRead(updated); await first })
        expect(writes).toBe(1)
        expect(busyDuringRead).toBe(true)
        expect(latest.bidding).toBe(false)
        expect(latest.state?.openNomination?.currentBidAmount).toBe(2)
        await act(async () => { renderer.unmount() })
    })

    it('bounds failed expiry retries and stops while the app is hidden', async () => {
        vi.useFakeTimers()
        const live = liveState('draft-a')
        live.openNomination!.countdownExpiresAt = new Date(Date.now() - 1000).toISOString()
        mocks.getDraftState.mockResolvedValue(live)
        mocks.closeExpiredNominations.mockRejectedValue(new Error('offline'))
        const Probe = () => { useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
        expect(mocks.closeExpiredNominations).toHaveBeenCalledTimes(1)
        mocks.appState = 'background'
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
        expect(mocks.closeExpiredNominations).toHaveBeenCalledTimes(1)
        mocks.appState = 'active'
        await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
        expect(mocks.closeExpiredNominations).toHaveBeenCalledTimes(5)
        await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
        expect(mocks.closeExpiredNominations).toHaveBeenCalledTimes(5)
        await act(async () => { renderer.unmount() })
    })

    it('retries an early zero-close result and stops after the server closes the nomination', async () => {
        vi.useFakeTimers()
        const live = liveState('draft-a')
        live.openNomination!.countdownExpiresAt = new Date(Date.now() - 1000).toISOString()
        mocks.getDraftState.mockResolvedValue(live)
        mocks.closeExpiredNominations.mockResolvedValueOnce({ closed: 0 }).mockResolvedValue({ closed: 1 })
        const Probe = () => { useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
        expect(mocks.closeExpiredNominations).toHaveBeenCalledTimes(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
        expect(mocks.closeExpiredNominations).toHaveBeenCalledTimes(2)
        await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
        expect(mocks.closeExpiredNominations).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })
})
