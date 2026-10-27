import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLeagueDraftController } from '@/hooks/use-league-draft-controller'
import type { Draft } from '@/lib/draft'
import { setSessionOwner } from '@/lib/session-cache-registry'

const mocks = vi.hoisted(() => ({
    confirmAction: vi.fn(),
    getActiveRookieDraft: vi.fn(),
    getRookieStartWarning: vi.fn(),
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
    acquireJoinableDraft: (leagueId: string, options: unknown) => ({ promise: mocks.getJoinableDraft(leagueId, options), release: vi.fn() }),
    NOMINATION_ORDER_MODE_LABELS: { user_nominated: "Manager's choice", by_projection: 'By projection rank', alphabetical: 'Alphabetical' },
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS: { auto_pick: 'Auto-pick', skip_pick: 'Skip', pause_draft: 'Pause', commissioner_pick: 'Commish pick' },
    startDraft: mocks.startDraft,
}))
vi.mock('@/lib/rookieDraft', () => ({
    getActiveRookieDraft: mocks.getActiveRookieDraft,
    getRookieStartWarning: mocks.getRookieStartWarning,
    reseedRookieDraftPicks: mocks.reseedRookieDraftPicks,
    startRookieDraft: mocks.startRookieDraft,
}))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: vi.fn(() => null),
    writePersistentCache: vi.fn(),
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
    setSessionOwner('actor')
    mocks.getRookieStartWarning.mockResolvedValue({ code: 'opening_night_unpublished', openingNightCutoff: null })
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

it('defers hidden draft status and retry, then joins one current read on return', async () => {
    const doc = new EventTarget()
    let hidden = true
    Object.defineProperty(doc, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', doc)
    mocks.getJoinableDraft.mockResolvedValue(draft('fresh'))
    let latest!: ReturnType<typeof useLeagueDraftController>
    const Probe = () => { latest = useLeagueDraftController('league'); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.retryActiveDraft() })
        expect(mocks.getJoinableDraft).not.toHaveBeenCalled()
        hidden = false
        await act(async () => { doc.dispatchEvent(new Event('visibilitychange')) })
        expect(mocks.getJoinableDraft).toHaveBeenCalledTimes(1)
        expect(latest.activeDraft?.id).toBe('fresh')
    } finally { await act(async () => { renderer.unmount() }); vi.unstubAllGlobals() }
})

it('fences same-league member changes and refuses unvalidated draft actions', async () => {
    const pending = deferred<Draft>()
    mocks.getJoinableDraft.mockReturnValueOnce(pending.promise).mockResolvedValue(draft('current'))
    let latest!: ReturnType<typeof useLeagueDraftController>
    const Probe = ({ member, authorized = true }: { member: string; authorized?: boolean }) => {
        latest = useLeagueDraftController('league', { memberId: member, authorized })
        return null
    }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe, { member: 'first' })) })
        await act(async () => { renderer.update(React.createElement(Probe, { member: 'second' })) })
        await act(async () => { pending.resolve(draft('stale')) })
        expect(latest.activeDraft?.id).toBe('current')
        await act(async () => { renderer.update(React.createElement(Probe, { member: 'second', authorized: false })) })
        await act(async () => { await latest.handleJoinDraftRoom(); await latest.handleStartDraft() })
        expect(mocks.push).not.toHaveBeenCalled()
        expect(mocks.confirmAction).not.toHaveBeenCalled()
    } finally { await act(async () => { renderer.unmount() }) }
})

it('shows the opening-night warning before any start request', async () => {
    mocks.getJoinableDraft.mockResolvedValue(null)
    mocks.getRookieStartWarning.mockResolvedValue({ code: 'opening_night_overrun', openingNightCutoff: '2026-10-20T13:00:00Z' })
    let latest!: ReturnType<typeof useLeagueDraftController>
    const Probe = () => { latest = useLeagueDraftController('league'); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        await act(async () => { latest.setDraftTimerSeconds(604800) })
        await act(async () => { await latest.handleStartRookieDraft() })
        expect(mocks.getRookieStartWarning).toHaveBeenCalledWith('league', expect.objectContaining({ timerSeconds: 604800 }))
        expect(mocks.confirmAction.mock.calls.at(-1)?.[1]).toContain('could run past opening night')
        expect(mocks.startRookieDraft).not.toHaveBeenCalled()
    } finally { await act(async () => { renderer.unmount() }) }
})

it('shows unpublished opening night before confirmation', async () => {
    mocks.getJoinableDraft.mockResolvedValue(null)
    let latest!: ReturnType<typeof useLeagueDraftController>
    const Probe = () => { latest = useLeagueDraftController('league'); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    try {
        await act(async () => { await latest.handleStartRookieDraft() })
        expect(mocks.confirmAction.mock.calls.at(-1)?.[1]).toContain('not published yet')
        expect(mocks.startRookieDraft).not.toHaveBeenCalled()
    } finally { await act(async () => { renderer.unmount() }) }
})

it('replaces submitted auction setup with the saved draft before opening its room', async () => {
    mocks.getJoinableDraft.mockResolvedValue(null)
    mocks.startDraft.mockResolvedValue(draft('saved-auction'))
    let confirm!: () => Promise<void>
    mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
    let latest!: ReturnType<typeof useLeagueDraftController>
    const Probe = () => { latest = useLeagueDraftController('league'); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => latest.setDraftTimerSeconds(30))
        await act(async () => latest.handleStartDraft())
        await act(async () => confirm())
        expect(mocks.startDraft).toHaveBeenCalledWith('league', 'user_nominated', { isMock: false, timerSeconds: 30 })
        expect(latest.activeDraft?.id).toBe('saved-auction')
        expect(mocks.push).toHaveBeenCalledWith({ pathname: '/(modals)/draft-room', params: { draftId: 'saved-auction' } })
    } finally { await act(async () => renderer?.unmount()) }
})

it('retains failed rookie options and clears them only after a completed start', async () => {
    mocks.getJoinableDraft.mockResolvedValue(null)
    mocks.startRookieDraft.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ draft: { id: 'saved-rookie', draftType: 'snake' } })
    let confirm!: () => Promise<void>
    mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
    let latest!: ReturnType<typeof useLeagueDraftController>
    const Probe = () => { latest = useLeagueDraftController('league'); return null }
    let renderer!: ReactTestRenderer
    try {
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { latest.setDraftTimerSeconds(300); latest.setRookieRounds(2); latest.setRookieTimerExpiryBehavior('skip_pick') })
        await act(async () => latest.handleStartRookieDraft())
        await act(async () => confirm())
        expect(latest.draftTimerSeconds).toBe(300)
        expect(latest.rookieRounds).toBe(2)
        expect(latest.rookieTimerExpiryBehavior).toBe('skip_pick')
        await act(async () => latest.handleStartRookieDraft())
        await act(async () => confirm())
        expect(mocks.startRookieDraft).toHaveBeenLastCalledWith('league', { isMock: false, timerSeconds: 300, rounds: 2, timerExpiryBehavior: 'skip_pick' })
        expect(latest.draftTimerSeconds).toBe(60)
        expect(latest.rookieRounds).toBe(3)
        expect(latest.rookieTimerExpiryBehavior).toBe('auto_pick')
    } finally { await act(async () => renderer?.unmount()) }
})
