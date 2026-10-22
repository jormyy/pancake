import React from 'react'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'
import type { RookieDraftState, RookieProspect } from '@/lib/rookieDraft'
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))

const boundary = vi.hoisted(() => ({
    state: vi.fn(), prospects: vi.fn(), revision: vi.fn(), pick: vi.fn(), expire: vi.fn(),
    subscribe: vi.fn(), unsubscribe: vi.fn(), callbacks: [] as (() => void)[],
    listeners: new Set<(state: 'active' | 'background') => void>(), appState: 'active' as 'active' | 'background',
    board: null as RookieDraftState | null, players: [] as RookieProspect[], version: 'initial',
    stateDelay: 50, prospectDelay: 50, revisionDelay: 50, failState: false, failProspects: false,
    activeState: 0, activeProspects: 0, activeRevision: 0, maxState: 0, maxProspects: 0, maxRevision: 0,
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return boundary.appState },
        addEventListener: (_event: string, listener: (state: 'active' | 'background') => void) => {
            boundary.listeners.add(listener)
            return { remove: () => { boundary.listeners.delete(listener) } }
        },
    },
}))
vi.mock('@/lib/rookieDraft', () => ({
    getRookieDraftState: boundary.state, getRookiePlayers: boundary.prospects, getRookieDraftPollRevision: boundary.revision,
    subscribeToRookieDraft: boundary.subscribe, unsubscribeFromRookieDraft: boundary.unsubscribe,
    makeSnakePick: boundary.pick, commissionerSnakePick: vi.fn(), processExpiredSnakePick: boundary.expire,
    activateRookieDraftLeague: vi.fn(async () => true),
}))
vi.mock('@/lib/roster', () => ({ getRoster: async () => [], dropPlayer: vi.fn() }))
vi.mock('@/lib/realtime', () => ({ reportRealtimeCleanup: vi.fn() }))
setSessionOwner('draft-test-user')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const players: RookieProspect[] = ['a', 'b'].map((id, index) => ({
    id, display_name: `${id === 'a' ? 'Alpha' : 'Beta'} Rookie`, nba_team: 'LAL', position: 'PG', nba_id: null, nba_draft_number: index + 1,
}))
const board = (id = 'draft'): RookieDraftState => {
    const picks = [1, 2].map((number) => ({
        overallPick: number, round: 1, pickInRound: number, memberId: 'member', teamName: 'Mine',
        pickedAt: null, skippedAt: null, skipReason: null, timerExpiresAt: null, player: null,
    }))
    return {
        draft: {
            id, leagueId: 'league', leagueSeasonId: 'season', isCurrentSeason: true, status: 'in_progress', isMock: false,
            pickTimerSeconds: 60, timerExpiryBehavior: 'skip_pick', rounds: 1, startedAt: null, completedAt: null,
            pauseReason: null, pausedAt: null, pausedRemainingSeconds: null,
        },
        picks, orders: [], nextPick: picks[0],
    }
}
const pickFirst = () => {
    boundary.board!.picks[0].player = { id: 'a', displayName: 'Alpha Rookie', nbaTeam: 'LAL', position: 'PG', nbaId: null }
    boundary.board!.picks[0].pickedAt = '2026-10-13T12:00:00Z'
    boundary.board!.nextPick = boundary.board!.picks[1]
    boundary.version = 'picked-a'
}
let latest: ReturnType<typeof useRookieDraftRoomController>
let renderer: ReactTestRenderer | null
let page: EventTarget
let visibility: 'visible' | 'hidden'
let snapshots: { at: number; pickedHidden: boolean; resetVisible: boolean; initialVisible: boolean }[]
const Probe = ({ draftId = 'draft', memberId = 'member' }: { draftId?: string; memberId?: string }) => {
    latest = useRookieDraftRoomController({ draftId, memberId, leagueId: 'league', rosterSize: 20 })
    snapshots.push({
        at: Date.now(), pickedHidden: latest.state?.picks[0]?.player?.id === 'a' && !latest.prospects.some((p) => p.id === 'a'),
        resetVisible: latest.state?.draft.status === 'pending' && latest.prospects.some((p) => p.id === 'a'),
        initialVisible: Boolean(latest.state) && latest.prospects.length === 2,
    })
    return null
}
const tree = () => React.createElement(Probe)
const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 5) {
        await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(5, ms - elapsed)) })
    }
}
const mount = async (resetCounters = true) => {
    await act(async () => { renderer = create(tree()) })
    await advance(500)
    if (resetCounters) {
        boundary.state.mockClear(); boundary.prospects.mockClear(); boundary.revision.mockClear()
        boundary.maxState = 0; boundary.maxProspects = 0; boundary.maxRevision = 0
        snapshots = []
    }
}
const event = async (_table: 'drafts' | 'snake_draft_picks' = 'snake_draft_picks') => {
    // Both watches use this same fallback callback in subscribeToRookieDraft.
    await act(async () => { boundary.callbacks.at(-1)!() })
}
const transaction = async () => { await event('snake_draft_picks'); await event('drafts') }
const setAppState = async (state: 'active' | 'background') => {
    boundary.appState = state
    visibility = state === 'active' ? 'visible' : 'hidden'
    await act(async () => {
        page.dispatchEvent(new Event('visibilitychange'))
        for (const listener of boundary.listeners) listener(state)
        renderer?.update(tree())
    })
}
const report = (workload: string, signalAt: number, reset = false) => {
    const visible = snapshots.find((snapshot) => snapshot.at >= signalAt
        && (workload === 'startup' ? snapshot.initialVisible : reset ? snapshot.resetVisible : snapshot.pickedHidden))
    const measured = {
        workload, stateReads: boundary.state.mock.calls.length, prospectReads: boundary.prospects.mock.calls.length,
        revisionProbes: boundary.revision.mock.calls.length, visibleMs: visible ? visible.at - signalAt : null,
        maxState: boundary.maxState, maxProspects: boundary.maxProspects, maxRevision: boundary.maxRevision,
    }
    console.info(`ROOKIE_RELOAD_MEASUREMENT ${JSON.stringify(measured)}`)
    return measured
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    boundary.board = board()
    boundary.players = structuredClone(players)
    boundary.version = 'initial'
    boundary.stateDelay = 50; boundary.prospectDelay = 50; boundary.revisionDelay = 50
    boundary.failState = false; boundary.failProspects = false
    boundary.activeState = 0; boundary.activeProspects = 0; boundary.activeRevision = 0
    boundary.maxState = 0; boundary.maxProspects = 0; boundary.maxRevision = 0
    boundary.appState = 'active'; boundary.listeners.clear(); boundary.callbacks = []
    boundary.state.mockReset().mockImplementation((id: string) => {
        const value = structuredClone({ ...boundary.board!, draft: { ...boundary.board!.draft, id } })
        const delay = boundary.stateDelay, fail = boundary.failState
        boundary.stateDelay = 50; boundary.failState = false
        boundary.maxState = Math.max(boundary.maxState, ++boundary.activeState)
        return new Promise<RookieDraftState>((resolve, reject) => {
            setTimeout(() => { boundary.activeState--; if (fail) reject(new Error('Board unavailable')); else resolve(value) }, delay)
        })
    })
    boundary.prospects.mockReset().mockImplementation((_id: string, query?: string) => {
        const picked = new Set(boundary.board!.picks.flatMap((pick) => pick.player ? [pick.player.id] : []))
        const value = structuredClone(boundary.players.filter((player) => !picked.has(player.id)
            && (!query || player.display_name.toLowerCase().includes(query.toLowerCase()))))
        const delay = boundary.prospectDelay, fail = boundary.failProspects
        boundary.prospectDelay = 50; boundary.failProspects = false
        boundary.maxProspects = Math.max(boundary.maxProspects, ++boundary.activeProspects)
        return new Promise<RookieProspect[]>((resolve, reject) => {
            setTimeout(() => { boundary.activeProspects--; if (fail) reject(new Error('Prospects unavailable')); else resolve(value) }, delay)
        })
    })
    boundary.revision.mockReset().mockImplementation(() => {
        const value = boundary.version, delay = boundary.revisionDelay
        boundary.revisionDelay = 50
        boundary.maxRevision = Math.max(boundary.maxRevision, ++boundary.activeRevision)
        return new Promise<string>((resolve) => { setTimeout(() => { boundary.activeRevision--; resolve(value) }, delay) })
    })
    boundary.subscribe.mockReset().mockImplementation((_id: string, callback: () => void) => {
        boundary.callbacks.push(callback)
        return {}
    })
    boundary.unsubscribe.mockReset().mockResolvedValue(undefined)
    boundary.pick.mockReset().mockResolvedValue({ rosterOverflow: false, taxiSlotsAvailable: true })
    boundary.expire.mockReset()
    renderer = null; snapshots = []; visibility = 'visible'
    page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => visibility })
    vi.stubGlobal('document', page)
})
afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it('loads the initial empty-query prospects once', async () => {
    const signalAt = Date.now()
    await mount(false)
    report('startup', signalAt)
    expect(boundary.state).toHaveBeenCalledTimes(1)
    expect(boundary.prospects).toHaveBeenCalledExactlyOnceWith('draft', undefined)
    expect(latest.prospects).toHaveLength(2)
})

it('coalesces one pick transaction across both watched tables', async () => {
    await mount()
    pickFirst()
    const signalAt = Date.now()
    await transaction()
    await advance(500)
    const measured = report('one-pick/two-tables', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(measured.stateReads).toBe(1)
    expect(measured.prospectReads).toBe(0)
    expect(measured.visibleMs).toBeLessThanOrEqual(300)
})

it('catches up a missed pick and prospect removal after rejoin', async () => {
    await mount()
    pickFirst()
    let recovered!: Promise<boolean>
    const reconnect = boundary.subscribe.mock.calls.at(-1)![2] as () => Promise<boolean>
    await act(async () => { recovered = reconnect() })
    await advance(100)
    expect(await recovered).toBe(true)
    expect(latest.state?.nextPick?.overallPick).toBe(2)
    expect(latest.prospects.map(player => player.id)).toEqual(['b'])
    expect(boundary.state).toHaveBeenCalledTimes(1)
    expect(boundary.prospects).toHaveBeenCalledTimes(1)
    expect(boundary.revision).not.toHaveBeenCalled()
    await act(async () => { renderer?.unmount() })
    const reads = boundary.state.mock.calls.length
    expect(await reconnect()).toBe(false)
    expect(boundary.state).toHaveBeenCalledTimes(reads)
})

it('coalesces repeated notifications of the same pick', async () => {
    await mount()
    pickFirst()
    const signalAt = Date.now()
    for (let repeat = 0; repeat < 10; repeat++) { await transaction(); await advance(5) }
    await advance(500)
    const measured = report('repeated-pick/20-notifications', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(measured.stateReads).toBe(1)
    expect(measured.prospectReads).toBe(0)
})

it('coalesces a 20-event reset and returns picked players to prospects', async () => {
    pickFirst()
    await mount()
    boundary.board = board()
    boundary.board.draft.status = 'pending'
    boundary.version = 'reset'
    const signalAt = Date.now()
    for (let repeat = 0; repeat < 10; repeat++) { await transaction(); await advance(5) }
    await advance(500)
    const measured = report('reset/20-events', signalAt, true)
    expect(latest.state?.draft.status).toBe('pending')
    expect(latest.prospects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(measured.stateReads).toBe(1)
    expect(measured.prospectReads).toBe(1)
})

it('queues one follow-up when a slow room read overlaps the 15-second poll', async () => {
    await mount()
    await advance(14200) // First event at 14.7 s; the coalesced read starts at 14.95 s.
    pickFirst()
    boundary.stateDelay = 500; boundary.prospectDelay = 500
    const signalAt = Date.now()
    await transaction()
    await advance(1000)
    const measured = report('500ms-room-read/poll-overlap', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(measured.stateReads).toBe(2)
    expect(measured.prospectReads).toBe(0)
    expect(measured.revisionProbes).toBe(1)
    expect(measured.maxState).toBe(1)
    expect(measured.maxProspects).toBe(0)
})

it('gates a 20-second revision probe while realtime still processes a pick', async () => {
    await mount()
    boundary.revisionDelay = 20000
    await advance(14500)
    await advance(15000)
    pickFirst()
    const signalAt = Date.now()
    await transaction()
    await advance(5600)
    const measured = report('20s-revision-probe/poll-overlap+pick', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(measured.revisionProbes).toBe(1)
    expect(measured.maxRevision).toBe(1)
    expect(measured.stateReads).toBe(1)
    expect(measured.prospectReads).toBe(0)
})

it('defers hidden notifications and catches up once on resume', async () => {
    await mount()
    await setAppState('background')
    await advance(30000)
    pickFirst()
    await transaction()
    await advance(500)
    const hiddenReads = boundary.state.mock.calls.length + boundary.prospects.mock.calls.length
    const signalAt = Date.now()
    await setAppState('active')
    await advance(500)
    const measured = report('hidden-pick/resume', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(hiddenReads).toBe(0)
    expect(measured.stateReads).toBe(1)
    expect(measured.prospectReads).toBe(0)
    expect(measured.revisionProbes).toBe(0)
})

it('keeps failed board reads due without reloading unchanged prospects', async () => {
    await mount()
    pickFirst()
    boundary.failState = true
    const signalAt = Date.now()
    await event()
    await advance(500)
    expect(latest.prospects.map((p) => p.id)).toEqual(['a', 'b'])
    await advance(15000)
    const measured = report('failed-pair/next-poll-recovery', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(measured.stateReads).toBe(2)
    expect(measured.prospectReads).toBe(0)
    expect(measured.revisionProbes).toBe(1)
})

it('retries prospects as well as the board on explicit refresh', async () => {
    await mount()
    pickFirst()
    boundary.players.push({ ...players[1], id: 'c', display_name: 'New Rookie' })
    const signalAt = Date.now()
    let refreshed!: Promise<unknown>
    await act(async () => { refreshed = latest.refresh() })
    await advance(100)
    await refreshed
    report('explicit-refresh/new-prospect', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b', 'c'])
    expect(boundary.prospects).toHaveBeenCalledTimes(1)
})

it('keeps skipped picks available and advances to the next unskipped pick', async () => {
    await mount()
    boundary.board!.picks[0].skippedAt = '2026-10-13T12:00:00Z'
    boundary.board!.picks[0].skipReason = 'timer_expired'
    boundary.board!.nextPick = boundary.board!.picks[1]
    await transaction()
    await advance(500)
    expect(latest.state?.nextPick?.overallPick).toBe(2)
    expect(latest.prospects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(boundary.expire).not.toHaveBeenCalled()
})

it('keeps taxi selection and merges mutation replies with realtime notifications', async () => {
    await mount()
    await act(async () => { latest.setDraftToTaxi(true) })
    boundary.pick.mockImplementation(async () => {
        pickFirst()
        const callback = boundary.callbacks.at(-1)!
        callback(); callback()
        return { rosterOverflow: false, taxiSlotsAvailable: true }
    })
    const signalAt = Date.now()
    let picked!: Promise<void>
    await act(async () => { picked = latest.handlePick(players[0]) })
    await advance(500)
    await picked
    const measured = report('taxi-pick/reply+two-events', signalAt)
    expect(boundary.pick).toHaveBeenCalledExactlyOnceWith('draft', 'member', 'a', true)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(latest.picking).toBe(false)
    expect(measured.stateReads).toBe(1)
    expect(measured.prospectReads).toBe(0)
})

it('preserves search debounce and resets the search on a new draft without a duplicate load', async () => {
    await mount()
    await act(async () => { latest.setQuery('Beta') })
    await advance(400)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(boundary.prospects).toHaveBeenLastCalledWith('draft', 'Beta')
    const before = boundary.prospects.mock.calls.length
    await act(async () => { renderer!.update(React.createElement(Probe, { draftId: 'other' })) })
    await advance(500)
    expect(latest.query).toBe('')
    expect(latest.prospects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(boundary.prospects.mock.calls.length - before).toBe(1)
})

it('rejects old callbacks after a draft switch and cancels queued work on unmount', async () => {
    await mount()
    const old = boundary.callbacks.at(-1)!
    await act(async () => { renderer!.update(React.createElement(Probe, { draftId: 'other' })) })
    await act(async () => { old() })
    await advance(500)
    expect(latest.state?.draft.id).toBe('other')
    const calls = boundary.state.mock.calls.length
    const callback = boundary.callbacks.at(-1)!
    await event()
    await act(async () => { renderer!.unmount(); renderer = null; callback() })
    await advance(500)
    expect(boundary.state).toHaveBeenCalledTimes(calls)
})

it('does not starve removal under continuous notifications every 100 ms for five seconds', async () => {
    await mount()
    pickFirst()
    const signalAt = Date.now()
    for (let index = 0; index < 50; index++) { await transaction(); await advance(100) }
    await advance(500)
    const measured = report('continuous-100-notifications/5s', signalAt)
    expect(measured.stateReads).toBeLessThanOrEqual(20)
    expect(measured.prospectReads).toBe(0)
    expect(measured.visibleMs).toBeLessThanOrEqual(300)
    expect(measured.maxState).toBe(1)
    expect(measured.maxProspects).toBe(0)
})

it('reads current state once after resume during an old pending revision probe', async () => {
    await mount()
    boundary.revisionDelay = 500
    await advance(14500)
    await advance(50)
    await setAppState('background')
    pickFirst()
    await advance(50)
    const signalAt = Date.now()
    await setAppState('active')
    await advance(700)
    const measured = report('resume/during-500ms-revision-probe', signalAt)
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(measured.revisionProbes).toBe(1)
    expect(measured.maxRevision).toBe(1)
    expect(measured.stateReads).toBe(1)
    expect(measured.prospectReads).toBe(0)
})

it('keeps expiry auto-picks and their mutation arguments', async () => {
    boundary.board!.draft.timerExpiryBehavior = 'auto_pick'
    boundary.board!.picks[0].timerExpiresAt = new Date(Date.now() + 1000).toISOString()
    boundary.board!.picks[1].memberId = 'other'
    boundary.expire.mockImplementation(async () => {
        pickFirst()
        const callback = boundary.callbacks.at(-1)!
        callback(); callback()
    })
    await mount()
    await advance(1000)
    expect(boundary.expire).toHaveBeenCalledExactlyOnceWith('draft', 'member')
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
    expect(boundary.state).toHaveBeenCalledTimes(1)
    expect(boundary.prospects).not.toHaveBeenCalled()
})

it('restores after effect replay and rejects the disposed subscription', async () => {
    await act(async () => { renderer = create(React.createElement(React.StrictMode, null, tree())) })
    await advance(500)
    expect(latest.state?.draft.id).toBe('draft')
    expect(latest.prospects).toHaveLength(2)
    const calls = boundary.state.mock.calls.length
    await act(async () => { boundary.callbacks[0]() })
    await advance(500)
    expect(boundary.state).toHaveBeenCalledTimes(calls)
})

it('ignores a retained lifecycle callback from the previous room', async () => {
    await mount()
    const oldLifecycle = [...boundary.listeners][0]
    await act(async () => { renderer!.update(React.createElement(Probe, { draftId: 'other' })) })
    await advance(500)
    await act(async () => { oldLifecycle('background') })
    pickFirst()
    await transaction()
    await advance(500)
    expect(latest.state?.draft.id).toBe('other')
    expect(latest.prospects.map((p) => p.id)).toEqual(['b'])
})


it('keeps the prospect pool across ordinary clock and pick events', async () => {
    await mount()
    await event('drafts')
    await advance(500)
    expect(boundary.prospects).not.toHaveBeenCalled()
    pickFirst()
    await transaction()
    await advance(500)
    expect(latest.prospects.map(player => player.id)).toEqual(['b'])
    expect(boundary.prospects).not.toHaveBeenCalled()
})

it.each(['no-op', 'error'])('retries an early expiry %s until the server accepts the same deadline', async (response) => {
    boundary.board!.draft.timerExpiryBehavior = 'auto_pick'
    boundary.board!.picks[0].timerExpiresAt = new Date(Date.now() - 1000).toISOString()
    boundary.board!.picks[1].memberId = 'other'
    const serverReadyAt = Date.now() + 6000
    boundary.expire.mockImplementation(async () => {
        if (Date.now() < serverReadyAt) {
            if (response === 'error') throw new Error('Pick timer has not expired')
            return { processed: false, picked: false }
        }
        pickFirst()
    })
    await mount()
    await advance(11000)
    expect(boundary.expire.mock.calls.length).toBeGreaterThan(1)
    expect(boundary.expire.mock.calls.length).toBeLessThanOrEqual(5)
    expect(latest.state?.nextPick?.overallPick).toBe(2)
    expect(latest.prospects.map(player => player.id)).toEqual(['b'])
})

// 110 s of fake time in 5 ms act() steps is 22,000 round-trips: about 0.6 s on an idle laptop, 3.2 s and over 5 s on a
// loaded CI host. The 30 s limit (50x idle, 6x the 5 s default it hit) covers that harness cost; a hang still fails.
it('caps retry frequency without permanently latching a very fast device clock', async () => {
    boundary.board!.draft.timerExpiryBehavior = 'auto_pick'
    boundary.board!.picks[0].timerExpiresAt = new Date(Date.now() - 1000).toISOString()
    boundary.board!.picks[1].memberId = 'other'
    const serverReadyAt = Date.now() + 80000
    boundary.expire.mockImplementation(async () => {
        if (Date.now() < serverReadyAt) return { processed: false, picked: false }
        pickFirst()
        return { processed: true, picked: true }
    })
    await mount()
    await advance(110000)
    expect(boundary.expire.mock.calls.length).toBeGreaterThan(5)
    expect(boundary.expire.mock.calls.length).toBeLessThanOrEqual(7)
    expect(latest.state?.nextPick?.overallPick).toBe(2)
}, 30_000)
