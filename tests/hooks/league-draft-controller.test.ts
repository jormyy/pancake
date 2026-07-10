import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLeagueDraftController } from '@/hooks/use-league-draft-controller'
import type { Draft } from '@/lib/draft'

const mocks = vi.hoisted(() => ({
    confirmAction: vi.fn(),
    getActiveRookieDraft: vi.fn(),
    getJoinableDraft: vi.fn(),
    push: vi.fn(),
    reseedRookieDraftPicks: vi.fn(),
    startDraft: vi.fn(),
    startRookieDraft: vi.fn(),
}))
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react')
    return { useFocusEffect: (callback: React.EffectCallback) => ReactModule.useEffect(callback, [callback]) }
})
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/alert', () => ({ confirmAction: mocks.confirmAction, showAlert: vi.fn() }))
vi.mock('@/components/league/DraftChips', () => ({ normalizeDraftTimerSeconds: (value: number) => value }))
vi.mock('@/lib/draft', () => ({
    getJoinableDraft: mocks.getJoinableDraft,
    NOMINATION_ORDER_MODE_LABELS: { user_nominated: "Manager's choice", by_projection: 'By projection rank', alphabetical: 'Alphabetical' },
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS: { auto_pick: 'Auto-pick', skip_pick: 'Skip', pause_draft: 'Pause', commissioner_pick: 'Commish pick' },
    startDraft: mocks.startDraft,
}))
vi.mock('@/lib/rookieDraft', () => ({
    getActiveRookieDraft: mocks.getActiveRookieDraft,
    reseedRookieDraftPicks: mocks.reseedRookieDraftPicks,
    startRookieDraft: mocks.startRookieDraft,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const draft = (id: string): Draft => ({
    id, leagueId: 'league', status: 'pending', draftType: 'auction', isMock: false,
    currentNominationOrder: 0, nominationOrderMode: 'user_nominated', budgetPerTeam: 200,
    scheduledAt: null, roomName: null, createdByMemberId: null, pickTimerSeconds: 30,
    timerExpiryBehavior: 'auction_no_bid', rounds: null, startedAt: null, pauseReason: null,
    pausedAt: null, pausedRemainingSeconds: null,
})

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('useLeagueDraftController', () => {
    it('deduplicates overlapping reads and runs a queued refresh after the first settles', async () => {
        const first = deferred<Draft>()
        const second = deferred<Draft>()
        mocks.getJoinableDraft.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        let latest!: ReturnType<typeof useLeagueDraftController>
        const Probe = () => {
            latest = useLeagueDraftController('league')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { void latest.fetchActiveDraft('league') })
        expect(mocks.getJoinableDraft).toHaveBeenCalledTimes(1)
        await act(async () => { first.resolve(draft('first')); await first.promise })
        expect(mocks.getJoinableDraft).toHaveBeenCalledTimes(2)
        await act(async () => { second.resolve(draft('second')); await second.promise })
        expect(latest.activeDraft?.id).toBe('second')
        expect(latest.activeDraftLoading).toBe(false)
        renderer.unmount()
    })

    it('retains a visible draft when a later refresh fails', async () => {
        mocks.getJoinableDraft.mockResolvedValueOnce(draft('visible')).mockRejectedValueOnce(new Error('offline'))
        let latest!: ReturnType<typeof useLeagueDraftController>
        const Probe = () => {
            latest = useLeagueDraftController('league')
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)); await Promise.resolve() })
        expect(latest.activeDraft?.id).toBe('visible')

        await act(async () => { await latest.fetchActiveDraft('league') })

        expect(latest.activeDraft?.id).toBe('visible')
        expect(latest.activeDraftError).toBe('offline')
        await act(async () => { renderer.unmount() })
    })

    it('cancels a pending start confirmation after the selected league changes', async () => {
        mocks.getJoinableDraft.mockResolvedValue(null)
        let confirm!: () => Promise<void>
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
        let latest!: ReturnType<typeof useLeagueDraftController>
        const Probe = ({ leagueId }: { leagueId: string }) => {
            latest = useLeagueDraftController(leagueId)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })); await Promise.resolve() })
        await act(async () => { await latest.handleStartDraft() })
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })) })
        await act(async () => { await confirm() })

        expect(mocks.startDraft).not.toHaveBeenCalled()
        expect(mocks.push).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('does not route or reseed an old league after deferred requests settle', async () => {
        mocks.getJoinableDraft.mockResolvedValueOnce(null)
        const join = deferred<Draft | null>()
        const activeRookie = deferred<{ id: string } | null>()
        let latest!: ReturnType<typeof useLeagueDraftController>
        const Probe = ({ leagueId }: { leagueId: string }) => {
            latest = useLeagueDraftController(leagueId)
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })); await Promise.resolve() })
        mocks.getJoinableDraft.mockReturnValueOnce(join.promise).mockResolvedValueOnce(null)
        mocks.getActiveRookieDraft.mockReturnValueOnce(activeRookie.promise)
        let joinRequest!: Promise<void>
        let reseedRequest!: Promise<void>
        await act(async () => {
            joinRequest = latest.handleJoinDraftRoom()
            reseedRequest = latest.handleReseedRookiePicks()
            await Promise.resolve()
        })
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })); await Promise.resolve() })
        await act(async () => {
            join.resolve(draft('draft-a'))
            activeRookie.resolve({ id: 'rookie-a' })
            await Promise.all([joinRequest, reseedRequest])
        })

        expect(mocks.push).not.toHaveBeenCalled()
        expect(mocks.reseedRookieDraftPicks).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})
