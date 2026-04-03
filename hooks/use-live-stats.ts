import { useEffect, useState, useRef } from 'react'
import { getTodaysGames, getLivePlayerStats, NBAGameRow, LiveStatLine } from '@/lib/games'
import { todayDateString } from '@/lib/shared/dates'
import { getStartedTeams, getTeamMatchups } from '@/lib/lineup'

export function useLiveStats(selectedDate: string, onSilentRefresh?: () => void) {
    const [todaysGames, setTodaysGames] = useState<NBAGameRow[]>([])
    const [liveStats, setLiveStats] = useState<Map<string, LiveStatLine>>(new Map())
    const startedTeamsRef = useRef<Set<string>>(new Set())
    const teamMatchupsRef = useRef<Map<string, { opponent: string; isHome: boolean }>>(new Map())
    const startedTeams = startedTeamsRef.current
    const teamMatchups = teamMatchupsRef.current

    useEffect(() => {
        getTodaysGames().then(setTodaysGames).catch(() => {})
    }, [])

    useEffect(() => {
        getLivePlayerStats(selectedDate).then(setLiveStats).catch(() => {})
        Promise.all([
            getStartedTeams(selectedDate).catch(() => new Set<string>()),
            getTeamMatchups(selectedDate).catch(() => new Map()),
        ]).then(([started, matchups]) => {
            startedTeamsRef.current = started
            teamMatchupsRef.current = matchups
        }).catch(() => {})

        if (selectedDate !== todayDateString()) return

        const interval = setInterval(async () => {
            const [newLiveStats, newGames, newStartedTeams] = await Promise.all([
                getLivePlayerStats(selectedDate).catch(() => null),
                getTodaysGames().catch(() => null),
                getStartedTeams(selectedDate).catch(() => null),
            ])
            if (newLiveStats) setLiveStats(newLiveStats)
            if (newGames) setTodaysGames(newGames)
            if (newStartedTeams) startedTeamsRef.current = newStartedTeams
            onSilentRefresh?.()
        }, 15_000)

        return () => clearInterval(interval)
    }, [selectedDate, onSilentRefresh])

    // Only apply live teams when viewing today — future dates can't have live games
    const isViewingToday = selectedDate === todayDateString()
    const liveTeams = new Set<string>(
        isViewingToday
            ? todaysGames
                .filter((g) => g.status === 'InProgress')
                .flatMap((g) => [g.home_team, g.away_team])
            : [],
    )

    return { todaysGames, liveStats, startedTeams, liveTeams, teamMatchups }
}
