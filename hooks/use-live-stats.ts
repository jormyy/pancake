import { useEffect, useMemo, useRef, useState } from 'react'
import { getTodaysGames, getLivePlayerStats, NBAGameRow, LiveStatLine } from '@/lib/games'
import { todayET } from '@/lib/shared/dates'
import { getStartedTeams, getTeamMatchups } from '@/lib/lineup'

type Snapshot = {
    todaysGames: NBAGameRow[]
    liveStats: Map<string, LiveStatLine>
    startedTeams: Set<string>
    teamMatchups: Map<string, { opponent: string; isHome: boolean }>
}

type Listener = (snapshot: Snapshot) => void

const EMPTY_SNAPSHOT: Snapshot = {
    todaysGames: [],
    liveStats: new Map(),
    startedTeams: new Set(),
    teamMatchups: new Map(),
}

const snapshots = new Map<string, Snapshot>()
const listenersByDate = new Map<string, Set<Listener>>()
const inFlightByDate = new Map<string, Promise<void>>()
const silentRefreshListenersByDate = new Map<string, Set<() => void>>()
let todayPoll: ReturnType<typeof setInterval> | null = null
const MAX_SNAPSHOT_DATES = 14

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

    const task = (async () => {
        const isToday = date === todayET()
        const previous = snapshots.get(date) ?? EMPTY_SNAPSHOT
        const [liveStats, startedTeams, teamMatchups, todaysGames] = await Promise.all([
            getLivePlayerStats(date).catch(() => previous.liveStats),
            getStartedTeams(date).catch(() => previous.startedTeams),
            getTeamMatchups(date).catch(() => previous.teamMatchups),
            isToday
                ? getTodaysGames().then((games) => {
                    todaysGamesFetchedAt = Date.now()
                    return games
                }).catch(() => previous.todaysGames)
                : Promise.resolve(previous.todaysGames),
        ])

        const snapshot = { todaysGames, liveStats, startedTeams, teamMatchups }
        snapshots.delete(date)
        snapshots.set(date, snapshot)
        evictSnapshots()
        notify(date, snapshot)
    })().finally(() => {
        inFlightByDate.delete(date)
    })

    inFlightByDate.set(date, task)
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

function ensureTodayPoll() {
    if (todayPoll) return
    todayPoll = setInterval(async () => {
        const today = todayET()
        if ((listenersByDate.get(today)?.size ?? 0) === 0) {
            clearInterval(todayPoll!)
            todayPoll = null
            return
        }

        // With no game in progress nothing is changing — back the poll off to
        // one snapshot per minute and skip the silent-refresh fan-out (which
        // reloads both visible lineups) entirely until play resumes.
        pollTick += 1
        const wasLive = anyGameInProgress(today)
        if (!wasLive && pollTick % 4 !== 0) return

        await loadSnapshot(today)
        // Fan out while games are live AND on the tick where the last game
        // flips to Final, so closing box scores still reach the lineups.
        if (!wasLive && !anyGameInProgress(today)) return
        for (const listener of silentRefreshListenersByDate.get(today) ?? []) listener()
    }, 15_000)
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

        loadSnapshot(selectedDate)
        if (selectedDate === todayET()) ensureTodayPoll()

        return () => {
            listeners?.delete(listener)
            if (listeners?.size === 0) listenersByDate.delete(selectedDate)
            evictSnapshots()
        }
    }, [selectedDate])

    const liveTeams = useMemo(() => {
        if (selectedDate !== todayET()) return new Set<string>()
        return new Set(
            snapshot.todaysGames
                .filter((g) => g.status === 'InProgress')
                .flatMap((g) => [g.home_team, g.away_team]),
        )
    }, [selectedDate, snapshot.todaysGames])

    return {
        todaysGames: snapshot.todaysGames,
        liveStats: liveStatsRef.current,
        startedTeams: snapshot.startedTeams,
        liveTeams,
        teamMatchups: teamMatchupsRef.current,
    }
}
