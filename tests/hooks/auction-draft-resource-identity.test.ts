import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'

const mocks = vi.hoisted(() => ({
    getDraftState: vi.fn(),
    placeBid: vi.fn(),
    resumeIfAbsent: vi.fn(),
    presenceCallback: null as ((ids: string[]) => void) | null,
    unsubscribeFromDraft: vi.fn(),
}))

vi.mock('@/lib/draft', () => ({
    closeExpiredNominations: vi.fn(),
    getDraftState: mocks.getDraftState,
    nominatePlayer: vi.fn(),
    pauseForAbsence: vi.fn(async () => undefined),
    placeBid: mocks.placeBid,
    resumeIfAbsent: mocks.resumeIfAbsent,
    searchPlayers: vi.fn(async () => []),
    subscribeToDraft: vi.fn(() => ({ topic: 'draft' })),
    subscribeToPresence: vi.fn((_draftId: string, _memberId: string, callback: (ids: string[]) => void) => {
        mocks.presenceCallback = callback
        return { topic: 'presence' }
    }),
    unsubscribeFromDraft: mocks.unsubscribeFromDraft,
    withdrawNomination: vi.fn(),
}))
vi.mock('@/lib/alert', () => ({ getErrorMessage: String, showAlert: vi.fn() }))

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
    mocks.presenceCallback = null
})

describe('auction draft resource identity', () => {
    it('cancels a pending automatic resume when the room owner unmounts', async () => {
        vi.useFakeTimers()
        mocks.getDraftState.mockResolvedValue(state('draft-a'))
        mocks.resumeIfAbsent.mockResolvedValue(undefined)
        const Probe = () => {
            useAuctionDraftRoomController({ draftId: 'draft-a', memberId: 'member' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        await act(async () => { mocks.presenceCallback?.(['member']); await Promise.resolve() })
        await act(async () => { renderer.unmount() })
        await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve() })

        expect(mocks.resumeIfAbsent).not.toHaveBeenCalled()
    })

    it('clears the previous draft while the next draft is loading', async () => {
        let resolveNext!: (value: DraftState) => void
        const next = new Promise<DraftState>((resolve) => { resolveNext = resolve })
        mocks.getDraftState.mockResolvedValueOnce(state('draft-a')).mockReturnValue(next)
        let latest!: ReturnType<typeof useAuctionDraftRoomController>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useAuctionDraftRoomController({ draftId, memberId: 'member' })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'draft-a' })); await Promise.resolve() })
        expect(latest.state?.draft.id).toBe('draft-a')
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'draft-b' })) })
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
})
