import { useEffect, useMemo, useRef, useState } from 'react'
import { getGameDay, getLivePlayerStats, NBAGameRow, LiveStatLine, type GameDay } from '@/lib/games'
import { deferLeagueRefresh, leagueChangeAffects, leagueChangesConnected, leagueSnapshotRevision, listenForLeagueChanges, waitForLeagueChanges } from '@/lib/league-changes'
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
    enabled?: boolean
    playerIds: readonly string[]
    leagueId?: string
    seasonId?: string
    onSilentRefresh?: () => void | boolean | Promise<void | boolean>
}
type LineupRefresh = {
    run: NonNullable<LiveStatsOptions['onSilentRefresh']>
    dueAt: number
    inFlight: boolean
    active: boolean
}
type Scope = { date: string; playerIds: string[]; generation: number; leagueId?: string; seasonId?: string }

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
const gameDays = new Map<string, { at: number; promise: Promise<GameDay>; settled: boolean }>()
const demands = new Map<string, number>()
const fulfilledDemands = new Map<string, number>()
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
        demands.delete(date)
        fulfilledDemands.delete(date)
        if (snapshots.size <= MAX_SNAPSHOTS) return
    }
}

function notify(date: string, snapshot: Snapshot) {
    for (const listener of listenersByScope.get(date) ?? []) listener(snapshot)
}

function readGameDay(scope: Scope): Promise<GameDay> {
    const key = JSON.stringify([scope.date, scope.generation, networkEpoch, scope.leagueId ? leagueSnapshotRevision(scope.leagueId, 'game') : null])
    const existing = gameDays.get(key)
    if (existing && (!existing.settled || Date.now() - existing.at < LIVE_POLL_MS)) return existing.promise
    const entry = { at: Date.now(), promise: getGameDay(scope.date), settled: false }
    gameDays.set(key, entry)
    while (gameDays.size > MAX_SNAPSHOTS) gameDays.delete(gameDays.keys().next().value!)
    void entry.promise.then(() => { entry.settled = true }, () => { if (gameDays.get(key) === entry) gameDays.delete(key) })
    return entry.promise
}

async function loadSnapshot(date: string): Promise<void> {
    const existing = inFlightByScope.get(date)
    if (existing) return existing
    if (pageHidden() || !browserOnline()) return

    const scope = scopes.get(date)
    if (!scope || scope.generation !== sessionGeneration()) return
    const epoch = networkEpoch
    const task = (async () => {
        if (scope.leagueId) await waitForLeagueChanges(scope.leagueId)
        if (epoch !== networkEpoch || scope.generation !== sessionGeneration() || pageHidden() || !browserOnline()) return
        const demand = demands.get(date) ?? 0
        const revision = scope.leagueId ? leagueSnapshotRevision(scope.leagueId, 'live') : null
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
            readGameDay(scope).catch(() => {
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
        if (!failed) fulfilledDemands.set(date, revision && revision === leagueSnapshotRevision(scope.leagueId!, 'live') ? demands.get(date) ?? demand : demand)
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
    const maxAge = anyGameInProgress(date) && !leagueChangesConnected(scopes.get(date)?.leagueId ?? '') ? LIVE_POLL_MS : IDLE_POLL_MS
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
    let watching = true
    let onlineQueued = false
    const online = () => {
        if (onlineQueued) return
        onlineQueued = true
        queueMicrotask(() => {
            onlineQueued = false
            if (!watching) return
            networkEpoch += 1
            gameDays.clear()
            resumeNeeded = true
            catchUpAfterHidden()
        })
    }
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
        watching = false
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
        await Promise.all(dates.filter(date => (anyGameInProgress(date) && !leagueChangesConnected(scopes.get(date)?.leagueId ?? '')) ||
            pollTick % (IDLE_POLL_MS / LIVE_POLL_MS) === 0).map(date => refreshLiveDate(date)))
    }, LIVE_POLL_MS)
}

onSessionCachesCleared(() => {
    networkEpoch += 1
    gameDays.clear()
    snapshots.clear()
    gamesFetchedAtByScope.clear()
    lineupCatchups.clear()
    demands.clear()
    fulfilledDemands.clear()
    for (const key of listenersByScope.keys()) notify(key, EMPTY_SNAPSHOT)
})

export function readCachedLiveTeams(leagueId: string): Set<string> | null {
    let latest: Snapshot | null = null
    for (const [key, scope] of scopes) {
        if (scope.leagueId !== leagueId || scope.date !== todayET() || scope.generation !== sessionGeneration() || !snapshotFresh(key)) continue
        const snapshot = snapshots.get(key)!
        if (!latest || snapshot.fetchedAt > latest.fetchedAt) latest = snapshot
    }
    if (!latest) return null
    const { todaysGames, startedTeams } = latest
    return new Set(todaysGames.filter(game => game.status === 'InProgress'
        || game.status === 'Scheduled' && startedTeams.has(game.home_team))
        .flatMap(game => [game.home_team, game.away_team]))
}

export function useLiveStats(selectedDate: string, options?: LiveStatsOptions) {
    const key = JSON.stringify([selectedDate, options?.scope ?? '', [...new Set(options?.playerIds ?? [])].sort(), sessionGeneration(), options?.leagueId, options?.seasonId])
    const scope = useMemo<Scope>(() => {
        const [date, , playerIds, generation, leagueId, seasonId] = JSON.parse(key) as [string, string, string[], number, string | undefined, string | undefined]
        return { date, playerIds, generation, leagueId, seasonId }
    }, [key])
    const enabled = options?.enabled ?? true
    const onSilentRefresh = enabled ? options?.onSilentRefresh : undefined
    const [resource, setResource] = useState<{ date: string; snapshot: Snapshot }>(() => ({
        date: key,
        snapshot: snapshots.get(key) ?? EMPTY_SNAPSHOT,
    }))
    const snapshot = !enabled ? EMPTY_SNAPSHOT : resource.date === key
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
        if (!enabled) return
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
    }, [enabled, key, scope])

    useEffect(() => {
        if (!enabled || !scope.leagueId || !scope.seasonId) return
        let disposed = false
        const refresh = deferLeagueRefresh(async () => {
            await inFlightByScope.get(key)
            if (disposed || scope.generation !== sessionGeneration()) return
            if ((fulfilledDemands.get(key) ?? -1) >= (demands.get(key) ?? 0) && snapshots.get(key)?.status === 'fresh') return true
            await refreshLiveDate(key)
            return snapshots.get(key)?.status === 'fresh'
        })
        const stop = listenForLeagueChanges(scope.leagueId, change => {
            if (!['stat', 'game', 'catchup'].includes(change.topic)) return
            if (leagueChangeAffects(change, { seasonId: scope.seasonId!, date: scope.date })) {
                demands.set(key, (demands.get(key) ?? 0) + 1)
                refresh.trigger()
            }
        })
        return () => { disposed = true; stop(); refresh.cancel() }
    }, [enabled, key, scope])

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
