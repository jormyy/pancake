import React from 'react'
import { setSessionOwner } from '@/lib/session-cache-registry'
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
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
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

setSessionOwner('draft-test-user')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const draftState = (id: string, status = 'in_progress'): RookieDraftState => ({
    draft: {
        id, leagueId: 'league', leagueSeasonId: 'draft-season', isCurrentSeason: true, status, isMock: false, pickTimerSeconds: 60,
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
    mocks.drop.mockResolvedValue(undefined)
    mocks.subscribe.mockReturnValue({})
})

describe('useRookieDraftRoomController', () => {
    it('hides old read errors before rendering another draft', async () => {
        const nextRoom = deferred<RookieDraftState>()
        const nextPool = deferred<never[]>()
        mocks.getState.mockImplementation((id: string) => id === 'a' ? Promise.reject(new Error('Old room failure')) : nextRoom.promise)
        mocks.getPlayers.mockImplementation((id: string) => id === 'a' ? Promise.reject(new Error('Old pool failure')) : nextPool.promise)
        const snapshots: { draftId: string; room: string | null; pool: string | null }[] = []
        const Harness = ({ draftId }: { draftId: string }) => {
            const value = useRookieDraftRoomController({ draftId, memberId: 'member', leagueId: 'league', rosterSize: 1 })
            snapshots.push({ draftId, room: value.loadError, pool: value.prospectsLoadError })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Harness, { draftId: 'a' })) })
        expect(snapshots.at(-1)).toMatchObject({ room: 'Old room failure', pool: 'Old pool failure' })
        await act(async () => renderer.update(React.createElement(Harness, { draftId: 'b' })))
        expect(snapshots.filter((value) => value.draftId === 'b').every((value) => value.room === null && value.pool === null)).toBe(true)
        await act(async () => { nextRoom.resolve(draftState('b')); nextPool.resolve([]) })
        await act(async () => renderer.unmount())
    })

    it('keeps prospect read failures separate and retryable', async () => {
        mocks.getState.mockResolvedValue(draftState('draft'))
        mocks.getPlayers.mockRejectedValueOnce(new Error('Prospects read unavailable'))
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        })) })
        expect(latest.state?.draft.id).toBe('draft')
        expect(Reflect.get(latest, 'prospectsLoadError')).toBe('Prospects read unavailable')
        expect(latest.pickError).toBeNull()
        await act(async () => { await latest.refresh() })
        expect(Reflect.get(latest, 'prospectsLoadError')).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('keeps a failed initial room read retryable and clears only its read error on recovery', async () => {
        mocks.getState.mockRejectedValueOnce(new Error('Draft read unavailable'))
        mocks.getState.mockResolvedValue(draftState('draft'))
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        })) })
        expect(latest.state).toBeNull()
        expect(Reflect.get(latest, 'loadError')).toBe('Draft read unavailable')
        expect(latest.pickError).toBeNull()
        await act(async () => { await latest.refresh() })
        expect(latest.state?.draft.id).toBe('draft')
        expect(Reflect.get(latest, 'loadError')).toBeNull()
        mocks.makePick.mockRejectedValueOnce(new Error('Pick rejected'))
        await act(async () => { await latest.handlePick({ id: 'rookie', display_name: 'Rookie', nba_team: 'FA', position: 'PG', nba_id: null, nba_draft_number: 1 }) })
        expect(latest.pickError).toBe('Pick rejected')
        expect(Reflect.get(latest, 'loadError')).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('keeps a completed historical room read-only while the current room can trim', async () => {
        let current = false
        mocks.getState.mockImplementation(() => Promise.resolve({ ...draftState('draft', 'completed'), draft: {
            ...draftState('draft', 'completed').draft, leagueSeasonId: 'draft-season', isCurrentSeason: current,
        } }))
        mocks.getRoster.mockResolvedValue([{ id: 'current-veteran', is_on_ir: false, is_on_taxi: false },
            { id: 'current-rookie', is_on_ir: false, is_on_taxi: false }])
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        })) })
        expect(latest.state?.draft.id).toBe('draft')
        expect(latest.trimOverflow).toBeNull()
        expect(mocks.getRoster).not.toHaveBeenCalled()
        await act(async () => { await latest.handleTrimDrop('current-veteran'); await latest.resolveByDrop('current-veteran') })
        expect(mocks.drop).not.toHaveBeenCalled()
        current = true
        await act(async () => { await latest.refresh() })
        expect(latest.trimOverflow?.excess).toBe(1)
        await act(async () => { await latest.handleTrimDrop('current-veteran') })
        expect(mocks.drop).toHaveBeenCalledWith('current-veteran', 'draft-season', 'draft')
        await act(async () => { renderer.unmount() })
    })

    it('removes completion actions when the same draft is reset, then checks its next completion', async () => {
        let status = 'completed'
        mocks.getState.mockImplementation(() => Promise.resolve(draftState('draft', status)))
        mocks.getRoster.mockResolvedValue([{ id: 'veteran', is_on_ir: false, is_on_taxi: false },
            { id: 'rookie', is_on_ir: false, is_on_taxi: false }])
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        })) })
        expect(latest.trimOverflow?.excess).toBe(1)
        const previousTrim = latest.handleTrimDrop
        status = 'in_progress'
        mocks.getRoster.mockResolvedValue([{ id: 'veteran', is_on_ir: false, is_on_taxi: false }])
        await act(async () => { await latest.refresh() })
        expect(latest.trimOverflow).toBeNull()
        await act(async () => { await previousTrim('veteran'); await latest.handleTrimDrop('veteran') })
        expect(mocks.drop).not.toHaveBeenCalled()
        status = 'completed'
        await act(async () => { mocks.appStateListener('background'); mocks.appStateListener('active') })
        expect(mocks.activate).toHaveBeenCalledWith('draft')
        await act(async () => { renderer.unmount() })
    })
    it('discards a completed roster read that finishes after same-draft reset', async () => {
        const roster = deferred<any[]>()
        let status = 'completed'
        mocks.getState.mockImplementation(() => Promise.resolve(draftState('draft', status)))
        mocks.getRoster.mockReturnValue(roster.promise)
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        })) })
        status = 'in_progress'
        await act(async () => { await latest.refresh() })
        await act(async () => { roster.resolve([]); await roster.promise })
        expect(mocks.activate).not.toHaveBeenCalled()
        expect(latest.trimOverflow).toBeNull()
        await act(async () => { renderer.unmount() })
    })
    it('discards roster completion and old drop callbacks when its season retires', async () => {
        const pending = deferred<any[]>()
        let isCurrentSeason = true
        mocks.getState.mockImplementation(() => Promise.resolve({ ...draftState('draft', 'completed'), draft: {
            ...draftState('draft', 'completed').draft, isCurrentSeason,
        } }))
        mocks.getRoster.mockReturnValue(pending.promise)
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        })) })
        const oldDrop = latest.handleTrimDrop
        expect(mocks.getRoster).toHaveBeenCalledWith('member', 'league', 'draft-season')
        isCurrentSeason = false
        await act(async () => { await latest.refresh() })
        await act(async () => { pending.resolve([{ id: 'a' }, { id: 'b' }]); await pending.promise; await oldDrop('a') })
        expect(latest.trimOverflow).toBeNull()
        expect(mocks.activate).not.toHaveBeenCalled()
        expect(mocks.drop).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
    it('clears a stale trim list when the read after a successful drop fails', async () => {
        const roster = ['a', 'b', 'c'].map((id) => ({ id, is_on_ir: false, is_on_taxi: false }))
        mocks.getState.mockImplementation(() => Promise.resolve(draftState('draft', 'completed')))
        mocks.getRoster.mockResolvedValueOnce(roster).mockRejectedValue(new Error('read failed'))
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 2 })
            return null
        })) })
        expect(latest.trimOverflow?.excess).toBe(1)
        await act(async () => { await latest.handleTrimDrop('a') })
        expect(mocks.drop).toHaveBeenCalledTimes(1)
        expect(latest.trimOverflow).toBeNull()
        const recoveryMessage = 'Player dropped. Refresh the roster before making another change.'
        expect(latest.completionError).toBe(recoveryMessage)
        await act(async () => {
            mocks.appStateListener('background')
            mocks.appStateListener('active')
        })
        expect(latest.completionError).toBe(recoveryMessage)
        expect(mocks.getRoster).toHaveBeenCalledTimes(2)
        expect(mocks.drop).toHaveBeenCalledTimes(1)
        mocks.getRoster.mockResolvedValue(roster.slice(1))
        await act(async () => { await latest.refresh() })
        expect(mocks.getRoster).toHaveBeenCalledTimes(3)
        expect(latest.trimOverflow).toBeNull()
        expect(mocks.activate).toHaveBeenCalledWith('draft')
        await act(async () => { renderer.unmount() })
    })
    it('requires a fresh roster after a lost drop reply before another trim action', async () => {
        const roster = ['a', 'b'].map((id) => ({ id, is_on_ir: false, is_on_taxi: false }))
        mocks.getState.mockImplementation(async () => draftState('draft', 'completed'))
        mocks.getRoster.mockImplementation(async () => [...roster])
        mocks.drop.mockImplementationOnce(async () => {
            roster.shift()
            throw new Error('Reply lost after commit')
        })
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
            return null
        })) })
        expect(latest.trimOverflow?.excess).toBe(1)
        await act(async () => { await latest.handleTrimDrop('a') })
        expect(latest.trimOverflow).toBeNull()
        expect(latest.completionError).toBe('Could not confirm the drop. Refresh the roster before making another change.')
        await act(async () => { await latest.handleTrimDrop('b') })
        expect(mocks.drop).toHaveBeenCalledTimes(1)
        await act(async () => { await latest.refresh() })
        expect(latest.trimOverflow).toBeNull()
        expect(latest.completionError).toBeNull()
        expect(mocks.activate).toHaveBeenCalledWith('draft')
        await act(async () => { renderer.unmount() })
    })
    it('filters changed picks locally and retries a failed explicit pool refresh', async () => {
        vi.useFakeTimers()
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const players = ['a', 'b'].map((id) => ({ id, display_name: id, nba_team: null, position: 'PG', nba_id: null, nba_draft_number: 1 }))
        const board = draftState('draft')
        mocks.getState.mockImplementation(async () => ({ ...board }))
        mocks.getPlayers.mockResolvedValue(players)
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        try {
            await act(async () => { renderer = create(React.createElement(() => {
                latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 1 })
                return null
            })) })
            await act(async () => { latest.setQuery('Rookie'); await vi.advanceTimersByTimeAsync(300) })
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
            expect(latest.prospects.map(p => p.id)).toEqual(['a', 'b'])
            const before = mocks.getPlayers.mock.calls.length
            board.picks = [{ overallPick: 1, round: 1, pickInRound: 1, memberId: 'other', teamName: 'Other', pickedAt: 'now',
                skippedAt: null, skipReason: null, timerExpiresAt: null,
                player: { id: 'a', displayName: 'a', nbaTeam: null, position: 'PG', nbaId: null } }]
            mocks.getRevision.mockResolvedValue('picked-a')
            mocks.getPlayers.mockRejectedValueOnce(new Error('Prospects unavailable')).mockResolvedValue([players[1]])
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
            expect(mocks.getPlayers.mock.calls.length).toBe(before)
            expect(latest.prospects.map(p => p.id)).toEqual(['b'])
            await act(async () => { await latest.refresh() })
            expect(mocks.getPlayers.mock.calls.length).toBe(before + 1)
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
            expect(mocks.getPlayers.mock.calls.length).toBe(before + 2)
            expect(mocks.getPlayers).toHaveBeenLastCalledWith('draft', 'Rookie')
            await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
            expect(mocks.getPlayers.mock.calls.length).toBe(before + 2)
            expect(latest.prospects.map(p => p.id)).toEqual(['b'])
        } finally {
            await act(async () => { renderer?.unmount() })
            vi.useRealTimers()
            consoleError.mockRestore()
        }
    })
    it('never checks or drops another selected league roster from this draft', async () => {
        mocks.getState.mockImplementation(() => Promise.resolve(draftState('draft', 'completed')))
        mocks.getRoster.mockResolvedValue([{ id: 'other-roster', is_on_ir: false, is_on_taxi: false }])
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(() => {
            latest = useRookieDraftRoomController({ draftId: 'draft', memberId: 'other-member', leagueId: 'other-league', rosterSize: 0 })
            return null
        })) })
        expect(mocks.getRoster).not.toHaveBeenCalled()
        expect(latest.trimOverflow).toBeNull()
        await act(async () => { await latest.handleTrimDrop('other-roster') })
        expect(mocks.drop).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
    it('never reads or trims the real roster when a mock completes', async () => {
        const completed = draftState('mock', 'completed')
        completed.draft.isMock = true
        mocks.getState.mockResolvedValue(completed)
        mocks.getRoster.mockResolvedValue([{ id: 'real-player', is_on_ir: false, is_on_taxi: false }])
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(() => {
                latest = useRookieDraftRoomController({ draftId: 'mock', memberId: 'member', leagueId: 'league', rosterSize: 0 })
                return null
            }))
        })
        expect(mocks.getRoster).not.toHaveBeenCalled()
        expect(mocks.activate).not.toHaveBeenCalled()
        expect(latest.trimOverflow).toBeNull()
        await act(async () => {
            await latest.handleTrimDrop('real-player')
            await latest.resolveByDrop('real-player')
        })
        expect(mocks.drop).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
    it('retries a failed completed-roster check after refresh', async () => {
        mocks.getState.mockImplementation(() => Promise.resolve(draftState('a', 'completed')))
        mocks.getRoster.mockRejectedValueOnce(new Error('roster unavailable')).mockResolvedValue([])
        let latest!: ReturnType<typeof useRookieDraftRoomController>
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(() => {
                latest = useRookieDraftRoomController({ draftId: 'a', memberId: 'member', leagueId: 'league', rosterSize: 20 })
                return null
            }))
        })
        expect(mocks.activate).not.toHaveBeenCalled()
        await act(async () => { await latest.refresh() })
        expect(mocks.getRoster).toHaveBeenCalledTimes(2)
        expect(mocks.activate).toHaveBeenCalledWith('a')
        await act(async () => { renderer.unmount() })
    })
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

    it('binds the first revision to a board read, then skips unchanged and background polls', async () => {
        vi.useFakeTimers()
        mocks.getState.mockResolvedValue(draftState('a'))
        mocks.getRevision.mockResolvedValueOnce('same').mockResolvedValueOnce('same').mockResolvedValueOnce('changed')
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
        expect(mocks.getState).toHaveBeenCalledTimes(2)
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
        expect(mocks.getState).toHaveBeenCalledTimes(2)
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
        expect(mocks.getState).toHaveBeenCalledTimes(3)

        mocks.appStateListener('background')
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
        expect(mocks.getRevision).toHaveBeenCalledTimes(3)
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
        expect(mocks.drop).toHaveBeenCalledWith('old-roster', 'draft-season', 'annual')
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

it('restarts a completion check discarded while the app is hidden', async () => {
    const first = deferred<any[]>()
    mocks.getState.mockImplementation(() => Promise.resolve(draftState('draft', 'completed')))
    mocks.getRoster.mockReturnValueOnce(first.promise).mockResolvedValue([])
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(() => {
        useRookieDraftRoomController({ draftId: 'draft', memberId: 'member', leagueId: 'league', rosterSize: 2 })
        return null
    })) })
    expect(mocks.getRoster).toHaveBeenCalledTimes(1)
    await act(async () => { mocks.appStateListener('background') })
    await act(async () => { first.resolve([]); await first.promise })
    expect(mocks.activate).not.toHaveBeenCalled()
    await act(async () => { mocks.appStateListener('active') })
    expect(mocks.getRoster).toHaveBeenCalledTimes(2)
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith('draft')
    await act(async () => { renderer.unmount() })
})
