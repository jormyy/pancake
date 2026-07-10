import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'

const mocks = vi.hoisted(() => ({
    getDraftState: vi.fn(),
    resumeIfAbsent: vi.fn(),
    presenceCallback: null as ((ids: string[]) => void) | null,
    unsubscribeFromDraft: vi.fn(),
}))

vi.mock('@/lib/draft', () => ({
    closeExpiredNominations: vi.fn(),
    getDraftState: mocks.getDraftState,
    nominatePlayer: vi.fn(),
    pauseForAbsence: vi.fn(async () => undefined),
    placeBid: vi.fn(),
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
})
