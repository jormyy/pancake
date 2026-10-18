import { useEffect, useMemo, useRef, useState } from 'react'
import { getGameDay, getLivePlayerStats, NBAGameRow, LiveStatLine } from '@/lib/games'
import { todayET } from '@/lib/shared/dates'
import { onSessionCachesCleared, sessionGeneration } from '@/lib/session-cache-registry'

type Snapshot = {
    todaysGames: NBAGameRow[]
    liveStats: Map<string, LiveStatLine>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    // When every read of the last load succeeded; 0 until then.
    fetchedAt: number
    status: 'fresh' | 'refreshing' | 'failed' | 'offline'
}

type LiveStatsOptions = {
    scope: string
    playerIds: readonly string[]
    onSilentRefresh?: () => void | boolean | Promise<void | boolean>
}
type LineupRefresh = {
    run: NonNullable<LiveStatsOptions['onSilentRefresh']>
    dueAt: number
    inFlight: boolean
    active: boolean
}
type Scope = { date: string; playerIds: string[]; generation: number }

type Listener = (snapshot: Snapshot) => void

const EMPTY_SNAPSHOT: Snapshot = {
    todaysGames: [],
    liveStats: new Map(),
    startedTeams: new Set(),
    teamMatchups: new Map(),
    fetchedAt: 0,
    status: 'refreshing',
}

const scopes = new Map<string, Scope>()
const snapshots = new Map<string, Snapshot>()
const listenersByScope = new Map<string, Set<Listener>>()
const inFlightByScope = new Map<string, Promise<void>>()
const inFlightEpochByScope = new Map<string, number>()
const gamesFetchedAtByScope = new Map<string, number>()
const silentRefreshListenersByScope = new Map<string, Set<LineupRefresh>>()
let pollInterval: ReturnType<typeof setInterval> | null = null
const MAX_SNAPSHOTS = 14
const LIVE_POLL_MS = 15_000
const IDLE_POLL_MS = 60_000
let networkEpoch = 0
let resumeNeeded = false
const lineupCatchups = new Set<string>()
const refreshesByScope = new Map<string, Promise<void>>()

function evictSnapshots() {
    if (snapshots.size <= MAX_SNAPSHOTS) return
    for (const date of snapshots.keys()) {
        if (listenersByScope.has(date)) continue
        snapshots.delete(date)
        gamesFetchedAtByScope.delete(date)
        scopes.delete(date)
        if (snapshots.size <= MAX_SNAPSHOTS) return
    }
}

function notify(date: string, snapshot: Snapshot) {
    for (const listener of listenersByScope.get(date) ?? []) listener(snapshot)
}

async function loadSnapshot(date: string): Promise<void> {
    const existing = inFlightByScope.get(date)
    if (existing) return existing
    if (pageHidden() || !browserOnline()) return

    const scope = scopes.get(date)
    if (!scope || scope.generation !== sessionGeneration()) return
    const epoch = networkEpoch
    const task = (async () => {
        const previous = snapshots.get(date) ?? EMPTY_SNAPSHOT
        const updating = { ...previous, status: 'refreshing' as const }
        snapshots.set(date, updating)
        notify(date, updating)
        let failed = false
        const [liveStats, gameDay] = await Promise.all([
            (scope.playerIds.length ? getLivePlayerStats(scope.date, scope.playerIds) : Promise.resolve(new Map<string, LiveStatLine>())).catch(() => {
                failed = true
                return previous.liveStats
            }),
            getGameDay(scope.date).catch(() => {
                failed = true
                return null
            }),
        ])
        if (epoch !== networkEpoch) return
        if (gameDay) gamesFetchedAtByScope.set(date, Date.now())

        const snapshot: Snapshot = {
            todaysGames: gameDay?.games ?? previous.todaysGames,
            liveStats,
            startedTeams: gameDay?.startedTeams ?? previous.startedTeams,
            teamMatchups: gameDay?.teamMatchups ?? previous.teamMatchups,
            // A failed read leaves the snapshot due, so the next mount retries.
            fetchedAt: failed ? previous.fetchedAt : Date.now(),
            status: failed ? 'failed' : 'fresh',
        }
        snapshots.delete(date)
        snapshots.set(date, snapshot)
        evictSnapshots()
        notify(date, snapshot)
        if (listenersByScope.has(date) && (scopes.get(date)?.date === todayET() || anyGameInProgress(date))) ensurePoll()
    })().finally(() => {
        inFlightByScope.delete(date)
        inFlightEpochByScope.delete(date)
    })

    inFlightByScope.set(date, task)
    inFlightEpochByScope.set(date, epoch)
    return task
}

let pollTick = 0

function anyGameInProgress(date: string): boolean {
    // A persistently failing games endpoint keeps serving the last snapshot;
    // don't let a frozen "InProgress" pin the aggressive poll + lineup
    // reload fan-out forever.
    if (Date.now() - (gamesFetchedAtByScope.get(date) ?? 0) > 15 * 60_000) return false
    return snapshots.get(date)?.todaysGames.some((g) => g.status === 'InProgress') ?? false
}

// A snapshot younger than the poll cadence is what a mounted screen would show
// anyway, so a remount or a return to the page reuses it.
function snapshotFresh(date: string): boolean {
    const snapshot = snapshots.get(date)
    const fetchedAt = snapshot?.fetchedAt ?? 0
    const maxAge = anyGameInProgress(date) ? LIVE_POLL_MS : IDLE_POLL_MS
    return snapshot?.status === 'fresh' && fetchedAt > 0 && Date.now() - fetchedAt < maxAge
}

function browserOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false
}

function pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

// Nothing is on screen while the page is hidden, so the poll skips its ticks.
// On return a snapshot older than the cadence refreshes at once, and live
// lineups with it.
function refreshLiveDate(date: string, forceLineups = false): Promise<void> {
    if (forceLineups && silentRefreshListenersByScope.has(date)) lineupCatchups.add(date)
    const existing = refreshesByScope.get(date)
    if (existing) return existing
    const task = (async () => {
        const wasLive = anyGameInProgress(date)
        let epoch: number
        do {
            epoch = inFlightEpochByScope.get(date) ?? networkEpoch
            await loadSnapshot(date)
        } while (epoch !== networkEpoch && browserOnline() && !pageHidden() && listenersByScope.has(date))
        if (!browserOnline() || pageHidden()) return
        const force = lineupCatchups.delete(date)
        if (!wasLive && !anyGameInProgress(date)) return
        for (const listener of silentRefreshListenersByScope.get(date) ?? []) {
            if (listener.inFlight || (!force && Date.now() < listener.dueAt)) continue
            listener.inFlight = true
            void Promise.resolve().then(() => listener.active ? listener.run() : false).then(result => {
                if (listener.active) listener.dueAt = result === false ? 0 : Date.now() + IDLE_POLL_MS
            }).catch(error => {
                if (!listener.active) return
                listener.dueAt = 0
                console.error('Could not refresh live lineups.', error)
            }).finally(() => { listener.inFlight = false })
        }
    })().finally(() => { refreshesByScope.delete(date) })
    refreshesByScope.set(date, task)
    return task
}

function catchUpAfterHidden() {
    if (!browserOnline() || pageHidden()) return
    const force = resumeNeeded
    resumeNeeded = false
    for (const date of listenersByScope.keys()) {
        if (force || !snapshotFresh(date)) void refreshLiveDate(date, true)
    }
}

let stopWatching: (() => void) | null = null
function watchVisibility() {
    if (stopWatching) return
    if (typeof document === 'undefined') return
    const online = () => { resumeNeeded = true; catchUpAfterHidden() }
    const offline = () => {
        networkEpoch += 1
        resumeNeeded = true
        for (const [date, snapshot] of snapshots) {
            const stale = { ...snapshot, status: 'offline' as const }
            snapshots.set(date, stale)
            notify(date, stale)
        }
    }
    document.addEventListener('visibilitychange', catchUpAfterHidden)
    if (typeof window !== 'undefined') {
        window.addEventListener('online', online)
        window.addEventListener('offline', offline)
        window.addEventListener('focus', catchUpAfterHidden)
    }
    stopWatching = () => {
        document.removeEventListener?.('visibilitychange', catchUpAfterHidden)
        if (typeof window !== 'undefined') {
            window.removeEventListener('online', online)
            window.removeEventListener('offline', offline)
            window.removeEventListener('focus', catchUpAfterHidden)
        }
        stopWatching = null
    }
}

function ensurePoll() {
    if (pollInterval) return
    watchVisibility()
    pollInterval = setInterval(async () => {
        const dates = [...listenersByScope.keys()].filter(date => scopes.get(date)?.date === todayET() || anyGameInProgress(date))
        if (dates.length === 0) {
            clearInterval(pollInterval!)
            pollInterval = null
            return
        }
        if (pageHidden() || !browserOnline()) return
        pollTick += 1
        await Promise.all(dates.filter(date => anyGameInProgress(date) ||
            pollTick % (IDLE_POLL_MS / LIVE_POLL_MS) === 0).map(date => refreshLiveDate(date)))
    }, LIVE_POLL_MS)
}

onSessionCachesCleared(() => {
    networkEpoch += 1
    snapshots.clear()
    gamesFetchedAtByScope.clear()
    lineupCatchups.clear()
    for (const key of listenersByScope.keys()) notify(key, EMPTY_SNAPSHOT)
})

export function useLiveStats(selectedDate: string, options?: LiveStatsOptions) {
    const key = JSON.stringify([selectedDate, options?.scope ?? '', [...new Set(options?.playerIds ?? [])].sort(), sessionGeneration()])
    const scope = useMemo<Scope>(() => {
        const [date, , playerIds, generation] = JSON.parse(key) as [string, string, string[], number]
        return { date, playerIds, generation }
    }, [key])
    const onSilentRefresh = options?.onSilentRefresh
    const [resource, setResource] = useState<{ date: string; snapshot: Snapshot }>(() => ({
        date: key,
        snapshot: snapshots.get(key) ?? EMPTY_SNAPSHOT,
    }))
    const snapshot = resource.date === key
        ? resource.snapshot
        : snapshots.get(key) ?? EMPTY_SNAPSHOT

    const liveStatsRef = useRef<Map<string, LiveStatLine>>(snapshot.liveStats)
    const teamMatchupsRef = useRef<Map<string, { opponent: string; isHome: boolean }>>(snapshot.teamMatchups)

    if (snapshot.liveStats !== liveStatsRef.current) {
        liveStatsRef.current = snapshot.liveStats
    }
    if (snapshot.teamMatchups !== teamMatchupsRef.current) {
        teamMatchupsRef.current = snapshot.teamMatchups
    }

    useEffect(() => {
        if (onSilentRefresh) {
            let listeners = silentRefreshListenersByScope.get(key)
            if (!listeners) {
                listeners = new Set()
                silentRefreshListenersByScope.set(key, listeners)
            }
            const listener: LineupRefresh = { run: onSilentRefresh, dueAt: Date.now() + IDLE_POLL_MS, inFlight: false, active: true }
            listeners.add(listener)
            return () => {
                listener.active = false
                listeners?.delete(listener)
                if (listeners?.size === 0) {
                    silentRefreshListenersByScope.delete(key)
                    lineupCatchups.delete(key)
                }
            }
        }
    }, [onSilentRefresh, key])

    useEffect(() => {
        scopes.set(key, scope)
        setResource({ date: key, snapshot: snapshots.get(key) ?? EMPTY_SNAPSHOT })

        let listeners = listenersByScope.get(key)
        if (!listeners) {
            listeners = new Set()
            listenersByScope.set(key, listeners)
        }
        const listener: Listener = (nextSnapshot) => setResource({ date: key, snapshot: nextSnapshot })
        listeners.add(listener)

        if (!snapshotFresh(key)) loadSnapshot(key)
        ensurePoll()

        return () => {
            listeners?.delete(listener)
            if (listeners?.size === 0) listenersByScope.delete(key)
            if (listenersByScope.size === 0) {
                stopWatching?.()
                if (pollInterval) clearInterval(pollInterval)
                pollInterval = null
            }
            evictSnapshots()
        }
    }, [key, scope])

    const liveTeams = useMemo(() => {
        if (!browserOnline() || snapshot.status !== 'fresh') return new Set<string>()
        return new Set(
            snapshot.todaysGames
                .filter((g) => g.status === 'InProgress')
                .flatMap((g) => [g.home_team, g.away_team]),
        )
    }, [snapshot.status, snapshot.todaysGames])

    return {
        todaysGames: snapshot.todaysGames,
        liveStats: liveStatsRef.current,
        startedTeams: snapshot.startedTeams,
        liveTeams,
        teamMatchups: teamMatchupsRef.current,
        freshness: browserOnline() ? snapshot.status : 'offline' as const,
    }
}
