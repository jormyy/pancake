import { useEffect, useMemo, useState } from 'react'
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
const silentRefreshListeners = new Set<() => void>()
let todayPoll: ReturnType<typeof setInterval> | null = null

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
            isToday ? getTodaysGames().catch(() => previous.todaysGames) : Promise.resolve(previous.todaysGames),
        ])

        const snapshot = { todaysGames, liveStats, startedTeams, teamMatchups }
        snapshots.set(date, snapshot)
        notify(date, snapshot)
    })().finally(() => {
        inFlightByDate.delete(date)
    })

    inFlightByDate.set(date, task)
    return task
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

        await loadSnapshot(today)
        for (const listener of silentRefreshListeners) listener()
    }, 15_000)
}

export function useLiveStats(selectedDate: string, onSilentRefresh?: () => void) {
    const [snapshot, setSnapshot] = useState<Snapshot>(() => snapshots.get(selectedDate) ?? EMPTY_SNAPSHOT)

    useEffect(() => {
        if (onSilentRefresh) {
            silentRefreshListeners.add(onSilentRefresh)
            return () => {
                silentRefreshListeners.delete(onSilentRefresh)
            }
        }
    }, [onSilentRefresh])

    useEffect(() => {
        setSnapshot(snapshots.get(selectedDate) ?? EMPTY_SNAPSHOT)

        let listeners = listenersByDate.get(selectedDate)
        if (!listeners) {
            listeners = new Set()
            listenersByDate.set(selectedDate, listeners)
        }
        listeners.add(setSnapshot)

        loadSnapshot(selectedDate)
        if (selectedDate === todayET()) ensureTodayPoll()

        return () => {
            listeners?.delete(setSnapshot)
            if (listeners?.size === 0) listenersByDate.delete(selectedDate)
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
        liveStats: snapshot.liveStats,
        startedTeams: snapshot.startedTeams,
        liveTeams,
        teamMatchups: snapshot.teamMatchups,
    }
}
