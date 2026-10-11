import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'
import type { RookieDraftState } from '@/lib/rookieDraft'

const mocks = vi.hoisted(() => ({
    activate: vi.fn(),
    drop: vi.fn(),
    appStateListener: vi.fn(),
    getRevision: vi.fn(),
    getRoster: vi.fn(),
    getState: vi.fn(),
    getPlayers: vi.fn(),
    makePick: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
}))
vi.mock('react-native', () => ({
    Alert: { alert: vi.fn() },
    AppState: {
        currentState: 'active',
        addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
            mocks.appStateListener.mockImplementation(listener)
            return { remove: vi.fn() }
        }),
    },
}))
vi.mock('@/lib/rookieDraft', () => ({
    activateRookieDraftLeague: mocks.activate,
    commissionerSnakePick: vi.fn(),
    getRookieDraftPollRevision: mocks.getRevision,
    getRookieDraftState: mocks.getState,
    getRookiePlayers: mocks.getPlayers,
    makeSnakePick: mocks.makePick,
    processExpiredSnakePick: vi.fn(),
    subscribeToRookieDraft: mocks.subscribe,
    unsubscribeFromRookieDraft: mocks.unsubscribe,
}))
vi.mock('@/lib/roster', () => ({ dropPlayer: mocks.drop, getRoster: mocks.getRoster, toggleTaxi: vi.fn() }))
vi.mock('@/lib/roster-locks', () => ({ getRosterStatusChangeLockMessage: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ reportRealtimeCleanup: vi.fn() }))
vi.mock('@/lib/alert', () => ({ getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const draftState = (id: string, status = 'in_progress'): RookieDraftState => ({
    draft: {
        id, leagueId: 'league', status, isMock: false, pickTimerSeconds: 60,
        timerExpiryBehavior: 'auto_pick', rounds: 3, startedAt: null, completedAt: null,
        pauseReason: null, pausedAt: null, pausedRemainingSeconds: null,
    },
    picks: [], orders: [], nextPick: null,
})

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPlayers.mockResolvedValue([])
    mocks.getRevision.mockResolvedValue('stable')
    mocks.getRoster.mockResolvedValue([])
    mocks.activate.mockResolvedValue(true)
    mocks.subscribe.mockReturnValue({})
})

describe('useRookieDraftRoomController', () => {
    it('gates the previous board on the first render after the draft changes', async () => {
        const second = deferred<RookieDraftState | null>()
        mocks.getState.mockImplementation((id: string) => id === 'a' ? Promise.resolve(draftState('a')) : second.promise)
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        const snapshots: { requested: string; stateId?: string; loading: boolean }[] = []
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useRookieDraftRoomController({ draftId, memberId: 'member', leagueId: 'league', rosterSize: 20 })
            snapshots.push({ requested: draftId, stateId: latest.state?.draft.id, loading: latest.loading })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'a' })); await Promise.resolve() })
        expect(latest.state?.draft.id).toBe('a')

        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'b' })) })

        expect(snapshots.find((snapshot) => snapshot.requested === 'b')).toEqual({
            requested: 'b', stateId: undefined, loading: true,
        })
        await act(async () => { second.resolve(draftState('b')); await second.promise })
        expect(latest.state?.draft.id).toBe('b')
        await act(async () => { renderer.unmount() })
    })

    it('runs post-draft activation once for each completed draft identity', async () => {
        mocks.getState.mockImplementation((id: string) => Promise.resolve(draftState(id, 'completed')))
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useRookieDraftRoomController({ draftId, memberId: 'member', leagueId: 'league', rosterSize: 20 })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'a' })); await Promise.resolve(); await Promise.resolve() })
        expect(mocks.activate).toHaveBeenCalledWith('a')

        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'b' })); await Promise.resolve(); await Promise.resolve() })

        expect(mocks.activate).toHaveBeenCalledWith('b')
        expect(mocks.activate).toHaveBeenCalledTimes(2)
        expect(latest.state?.draft.id).toBe('b')
        await act(async () => { renderer.unmount() })
    })

    it('uses a foreground-only revision poll and reloads the board only on change', async () => {
        vi.useFakeTimers()
        mocks.getState.mockResolvedValue(draftState('a'))
        mocks.getRevision.mockResolvedValueOnce('same').mockResolvedValueOnce('changed')
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(() => {
                useRookieDraftRoomController({ draftId: 'a', memberId: 'member', leagueId: 'league', rosterSize: 20 })
                return null
            }))
            await Promise.resolve()
        })
        expect(mocks.getState).toHaveBeenCalledTimes(1)

        await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
        expect(mocks.getRevision).toHaveBeenCalledTimes(1)
        expect(mocks.getState).toHaveBeenCalledTimes(1)
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
        expect(mocks.getState).toHaveBeenCalledTimes(2)

        mocks.appStateListener('background')
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
        expect(mocks.getRevision).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
        vi.useRealTimers()
    })

    it('discards overflow state from a pick that completes after the draft changes', async () => {
        const pick = deferred<{ rosterOverflow: boolean; taxiSlotsAvailable: boolean }>()
        mocks.makePick.mockReturnValue(pick.promise)
        mocks.getState.mockImplementation((id: string) => Promise.resolve(draftState(id)))
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useRookieDraftRoomController({ draftId, memberId: 'member', leagueId: 'league', rosterSize: 20 })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'a' })); await Promise.resolve() })
        let pending!: Promise<void>
        await act(async () => {
            pending = latest.handlePick({
                id: 'rookie', display_name: 'Rookie', nba_team: 'LAL', position: 'PG', nba_id: null, nba_draft_number: 1,
            })
            await Promise.resolve()
        })
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'b' })); await Promise.resolve() })
        await act(async () => { pick.resolve({ rosterOverflow: true, taxiSlotsAvailable: true }); await pending })

        expect(latest.state?.draft.id).toBe('b')
        expect(latest.rosterOverflow).toBeNull()
        expect(latest.rosterForDrop).toEqual([])
        expect(latest.picking).toBe(false)
        expect(mocks.getRoster).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})


describe('annual draft overflow completion', () => {
    it('uses one final trim and removes it after the actual remaining roster fits', async () => {
        const roster = [
            { id: 'old-roster', is_on_ir: false, is_on_taxi: false, players: { id: 'old', display_name: 'Old' } },
            { id: 'new-roster', is_on_ir: false, is_on_taxi: false, players: { id: 'rookie', display_name: 'Rookie' } },
        ]
        mocks.getState.mockResolvedValue(draftState('annual'))
        mocks.getRoster.mockImplementation(async () => [...roster])
        mocks.drop.mockImplementation(async (id: string) => { roster.splice(roster.findIndex((r) => r.id === id), 1) })
        mocks.makePick.mockImplementation(async () => {
            mocks.getState.mockResolvedValue(draftState('annual', 'completed'))
            return { rosterOverflow: true, taxiSlotsAvailable: false }
        })
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(() => {
                latest = useRookieDraftRoomController({ draftId: 'annual', memberId: 'member', leagueId: 'league', rosterSize: 1 })
                return null
            }))
        })
        await act(async () => {
            await latest.handlePick({ id: 'rookie', display_name: 'Rookie', nba_team: null, position: 'PG', nba_id: null, nba_draft_number: 1 })
        })
        expect(latest.trimOverflow?.excess).toBe(1)
        expect(latest.rosterOverflow).toBeNull()
        await act(async () => { await latest.handleTrimDrop('old-roster') })
        expect(mocks.drop).toHaveBeenCalledWith('old-roster')
        expect(latest.trimOverflow).toBeNull()
        expect(latest.rosterOverflow).toBeNull()
        expect(latest.rosterForDrop).toEqual([])
        expect(mocks.activate).toHaveBeenCalledWith('annual')
        await act(async () => { renderer.unmount() })
    })
})


describe('annual draft late roster lookup', () => {
    it('discards an old rejected roster lookup after changing drafts', async () => {
        const roster = deferred<never[]>()
        mocks.getState.mockImplementation(async (id: string) => draftState(id))
        mocks.getRoster.mockReturnValue(roster.promise)
        mocks.makePick.mockResolvedValue({ rosterOverflow: true, taxiSlotsAvailable: false })
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        const Probe = ({ draftId }: { draftId: string }) => {
            latest = useRookieDraftRoomController({ draftId, memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { draftId: 'old' })) })
        let pending!: Promise<void>
        await act(async () => {
            pending = latest.handlePick({ id: 'rookie', display_name: 'Rookie', nba_team: null, position: 'PG', nba_id: null, nba_draft_number: 1 })
        })
        expect(mocks.getRoster).toHaveBeenCalled()
        await act(async () => { renderer.update(React.createElement(Probe, { draftId: 'new' })) })
        await act(async () => { roster.reject(new Error('Old roster failed')); await pending })
        expect(latest.state?.draft.id).toBe('new')
        expect(latest.rosterOverflow).toBeNull()
        expect(latest.rosterForDrop).toEqual([])
        await act(async () => { renderer.unmount() })
        consoleError.mockRestore()
    })
})


describe('annual draft roster read recovery', () => {
    it('keeps navigation available and explains recovery when an acquired roster cannot load', async () => {
        mocks.getState.mockResolvedValue(draftState('annual'))
        mocks.getRoster.mockRejectedValue(new Error('Roster unavailable'))
        mocks.makePick.mockResolvedValue({ rosterOverflow: true, taxiSlotsAvailable: false })
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(() => {
                latest = useRookieDraftRoomController({ draftId: 'annual', memberId: 'member', leagueId: 'league', rosterSize: 1 })
                return null
            }))
        })
        await act(async () => {
            await latest.handlePick({ id: 'rookie', display_name: 'Rookie', nba_team: null, position: 'PG', nba_id: null, nba_draft_number: 1 })
        })
        expect(latest.rosterOverflow).toBeNull()
        expect(latest.pickError).toBe('Player drafted, but roster details could not load. Open Roster to resolve any overflow.')
        expect(latest.picking).toBe(false)
        await act(async () => { renderer.unmount() })
        consoleError.mockRestore()
    })
})
