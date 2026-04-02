import { useEffect, useState } from 'react'
import { getTodaysGames, getLivePlayerStats, NBAGameRow, LiveStatLine } from '@/lib/games'
import { todayDateString } from '@/lib/shared/dates'
import { getStartedTeams } from '@/lib/lineup'

export function useLiveStats(selectedDate: string) {
    const [todaysGames, setTodaysGames] = useState<NBAGameRow[]>([])
    const [liveStats, setLiveStats] = useState<Map<string, LiveStatLine>>(new Map())
    const [startedTeams, setStartedTeams] = useState<Set<string>>(new Set())

    useEffect(() => {
        getTodaysGames().then(setTodaysGames).catch(() => {})
    }, [])

    useEffect(() => {
        getLivePlayerStats(selectedDate).then(setLiveStats).catch(() => {})
        getStartedTeams(selectedDate).then(setStartedTeams).catch(() => {})

        const isToday = selectedDate === todayDateString()
        if (!isToday) return

        const interval = setInterval(() => {
            getTodaysGames().then(setTodaysGames).catch(() => {})
            getLivePlayerStats(selectedDate).then(setLiveStats).catch(() => {})
            getStartedTeams(selectedDate).then(setStartedTeams).catch(() => {})
        }, 15_000)

        return () => clearInterval(interval)
    }, [selectedDate])

    // Only apply live teams when viewing today — future dates can't have live games
    const isViewingToday = selectedDate === todayDateString()
    const liveTeams = new Set<string>(
        isViewingToday
            ? todaysGames
                .filter((g) => g.status === 'InProgress')
                .flatMap((g) => [g.home_team, g.away_team])
            : [],
    )

    return { todaysGames, liveStats, startedTeams, setStartedTeams, liveTeams }
}
