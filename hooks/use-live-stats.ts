import { useEffect, useMemo, useRef, useState } from 'react'
import { getGameDay, getLivePlayerStats, NBAGameRow, LiveStatLine } from '@/lib/games'
import { todayET } from '@/lib/shared/dates'

type Snapshot = {
    todaysGames: NBAGameRow[]
    liveStats: Map<string, LiveStatLine>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
    // When every read of the last load succeeded; 0 until then.
    fetchedAt: number
    status: 'fresh' | 'refreshing' | 'failed' | 'offline'
}

type Listener = (snapshot: Snapshot) => void

const EMPTY_SNAPSHOT: Snapshot = {
    todaysGames: [],
    liveStats: new Map(),
    startedTeams: new Set(),
    teamMatchups: new Map(),
    fetchedAt: 0,
    status: 'refreshing',
}

const snapshots = new Map<string, Snapshot>()
const listenersByDate = new Map<string, Set<Listener>>()
const inFlightByDate = new Map<string, Promise<void>>()
const inFlightEpochByDate = new Map<string, number>()
const silentRefreshListenersByDate = new Map<string, Set<() => void>>()
let todayPoll: ReturnType<typeof setInterval> | null = null
const MAX_SNAPSHOT_DATES = 14
const LIVE_POLL_MS = 15_000
const IDLE_POLL_MS = 60_000
let networkEpoch = 0
let resumeNeeded = false
const refreshesByDate = new Map<string, Promise<void>>()

function evictSnapshots() {
    if (snapshots.size <= MAX_SNAPSHOT_DATES) return
    for (const date of snapshots.keys()) {
        if (listenersByDate.has(date)) continue
        snapshots.delete(date)
        if (snapshots.size <= MAX_SNAPSHOT_DATES) return
    }
}

function notify(date: string, snapshot: Snapshot) {
    for (const listener of listenersByDate.get(date) ?? []) listener(snapshot)
}

async function loadSnapshot(date: string): Promise<void> {
    const existing = inFlightByDate.get(date)
    if (existing) return existing
    if (pageHidden() || !browserOnline()) return

    const epoch = networkEpoch
    const task = (async () => {
        const isToday = date === todayET()
        const previous = snapshots.get(date) ?? EMPTY_SNAPSHOT
        const updating = { ...previous, status: 'refreshing' as const }
        snapshots.set(date, updating)
        notify(date, updating)
        let failed = false
        const [liveStats, gameDay] = await Promise.all([
            getLivePlayerStats(date).catch(() => {
                failed = true
                return previous.liveStats
            }),
            getGameDay(date).catch(() => {
                failed = true
                return null
            }),
        ])
        if (epoch !== networkEpoch) return
        if (isToday && gameDay) todaysGamesFetchedAt = Date.now()

        const snapshot: Snapshot = {
            todaysGames: isToday && gameDay ? gameDay.games : previous.todaysGames,
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
    })().finally(() => {
        inFlightByDate.delete(date)
        inFlightEpochByDate.delete(date)
    })

    inFlightByDate.set(date, task)
    inFlightEpochByDate.set(date, epoch)
    return task
}

let pollTick = 0
let todaysGamesFetchedAt = 0

function anyGameInProgress(date: string): boolean {
    // A persistently failing games endpoint keeps serving the last snapshot;
    // don't let a frozen "InProgress" pin the aggressive poll + lineup
    // reload fan-out forever.
    if (Date.now() - todaysGamesFetchedAt > 15 * 60_000) return false
    return snapshots.get(date)?.todaysGames.some((g) => g.status === 'InProgress') ?? false
}

// A snapshot younger than the poll cadence is what a mounted screen would show
// anyway, so a remount or a return to the page reuses it.
function snapshotFresh(date: string): boolean {
    const snapshot = snapshots.get(date)
    const fetchedAt = snapshot?.fetchedAt ?? 0
    const maxAge = date === todayET() && anyGameInProgress(date) ? LIVE_POLL_MS : IDLE_POLL_MS
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
function refreshLiveDate(date: string): Promise<void> {
    const existing = refreshesByDate.get(date)
    if (existing) return existing
    const task = (async () => {
        const wasLive = anyGameInProgress(date)
        let epoch: number
        do {
            epoch = inFlightEpochByDate.get(date) ?? networkEpoch
            resumeNeeded = false
            await loadSnapshot(date)
        } while (epoch !== networkEpoch && browserOnline() && !pageHidden() && listenersByDate.has(date))
        if (!browserOnline() || pageHidden() || snapshots.get(date)?.status !== 'fresh') return
        if (!wasLive && !anyGameInProgress(date)) return
        for (const listener of silentRefreshListenersByDate.get(date) ?? []) listener()
    })().finally(() => { refreshesByDate.delete(date) })
    refreshesByDate.set(date, task)
    return task
}

function catchUpAfterHidden() {
    const today = todayET()
    if (!browserOnline() || pageHidden() || (listenersByDate.get(today)?.size ?? 0) === 0) return
    if (!resumeNeeded && snapshotFresh(today)) return
    void refreshLiveDate(today)
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

function ensureTodayPoll() {
    if (todayPoll) return
    watchVisibility()
    todayPoll = setInterval(async () => {
        const today = todayET()
        if ((listenersByDate.get(today)?.size ?? 0) === 0) {
            clearInterval(todayPoll!)
            todayPoll = null
            return
        }
        if (pageHidden() || !browserOnline()) return

        // With no game in progress nothing is changing — back the poll off to
        // one snapshot per minute and skip the silent-refresh fan-out (which
        // reloads both visible lineups) entirely until play resumes.
        pollTick += 1
        const wasLive = anyGameInProgress(today)
        if (!wasLive && pollTick % (IDLE_POLL_MS / LIVE_POLL_MS) !== 0) return

        await refreshLiveDate(today)
    }, LIVE_POLL_MS)
}

export function useLiveStats(selectedDate: string, onSilentRefresh?: () => void) {
    const [resource, setResource] = useState<{ date: string; snapshot: Snapshot }>(() => ({
        date: selectedDate,
        snapshot: snapshots.get(selectedDate) ?? EMPTY_SNAPSHOT,
    }))
    const snapshot = resource.date === selectedDate
        ? resource.snapshot
        : snapshots.get(selectedDate) ?? EMPTY_SNAPSHOT

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
            let listeners = silentRefreshListenersByDate.get(selectedDate)
            if (!listeners) {
                listeners = new Set()
                silentRefreshListenersByDate.set(selectedDate, listeners)
            }
            listeners.add(onSilentRefresh)
            return () => {
                listeners?.delete(onSilentRefresh)
                if (listeners?.size === 0) silentRefreshListenersByDate.delete(selectedDate)
            }
        }
    }, [onSilentRefresh, selectedDate])

    useEffect(() => {
        setResource({ date: selectedDate, snapshot: snapshots.get(selectedDate) ?? EMPTY_SNAPSHOT })

        let listeners = listenersByDate.get(selectedDate)
        if (!listeners) {
            listeners = new Set()
            listenersByDate.set(selectedDate, listeners)
        }
        const listener: Listener = (nextSnapshot) => setResource({ date: selectedDate, snapshot: nextSnapshot })
        listeners.add(listener)

        if (!snapshotFresh(selectedDate)) loadSnapshot(selectedDate)
        if (selectedDate === todayET()) ensureTodayPoll()

        return () => {
            listeners?.delete(listener)
            if (listeners?.size === 0) listenersByDate.delete(selectedDate)
            if (listenersByDate.size === 0) {
                stopWatching?.()
                if (todayPoll) clearInterval(todayPoll)
                todayPoll = null
            }
            evictSnapshots()
        }
    }, [selectedDate])

    const liveTeams = useMemo(() => {
        if (selectedDate !== todayET() || !browserOnline() || snapshot.status !== 'fresh') return new Set<string>()
        return new Set(
            snapshot.todaysGames
                .filter((g) => g.status === 'InProgress')
                .flatMap((g) => [g.home_team, g.away_team]),
        )
    }, [selectedDate, snapshot.status, snapshot.todaysGames])

    return {
        todaysGames: snapshot.todaysGames,
        liveStats: liveStatsRef.current,
        startedTeams: snapshot.startedTeams,
        liveTeams,
        teamMatchups: teamMatchupsRef.current,
        freshness: browserOnline() ? snapshot.status : 'offline' as const,
    }
}
