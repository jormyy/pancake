import { useMatchupGameTimes } from '@/hooks/use-matchup-game-times'
import type { MatchupGame } from '@/components/MatchupRow'
import type { LeagueInfo } from '@/types/app'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import type { HomeView } from '@/lib/cache/view-types'
import type { MatchupContext } from '@/lib/scoring'
import type { NBAGameRow, LiveStatLine } from '@/lib/games'
import type { LeagueAnnouncement } from '@/lib/league-announcements'
import type { MatchupForecast } from '@/hooks/use-matchup-forecast'
import { endOfLeagueDayUTC, resolveLeagueTimezone, todayLeague } from '@/lib/timezone'

type HomePayload = HomeView & { forecast: MatchupForecast | null; announcements: LeagueAnnouncement[]; todaysGames: NBAGameRow[]; liveStats: Record<string, LiveStatLine>; startedTeams: string[]; teamMatchups: Record<string, { opponent: string; isHome: boolean }> }

export function useMatchupData(current: { id: string; team_name?: string | null; role?: string } | null, user: { id: string } | null, league: Pick<LeagueInfo, 'id'> & Partial<LeagueInfo> | null, membershipValidated = true, membershipError: Error | null = null, refreshMemberships?: () => Promise<void>, matchupId?: string, initialDate?: string) {
    const focused = useIsFocused()
    const timezone = resolveLeagueTimezone(league?.timezone)
    const [calendar, setCalendar] = useState(() => ({ timezone, day: todayLeague(timezone) }))
    const day = calendar.timezone === timezone ? calendar.day : todayLeague(timezone)
    const setDay = useCallback((value: string) => setCalendar(previous => previous.timezone === timezone && previous.day === value ? previous : { timezone, day: value }), [timezone])
    useEffect(() => {
        const update = () => setDay(todayLeague(timezone))
        update()
        const timer = setTimeout(update, Math.max(1, Date.parse(endOfLeagueDayUTC(day, timezone)) - Date.now() + 1))
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', update)
            window.addEventListener('pageshow', update)
            window.addEventListener('online', update)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update)
        return () => {
            clearTimeout(timer)
            if (typeof window !== 'undefined') {
                window.removeEventListener('focus', update)
                window.removeEventListener('pageshow', update)
                window.removeEventListener('online', update)
            }
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update)
        }
    }, [day, timezone, setDay])
    const identity = JSON.stringify([user?.id, league?.id, current?.id, timezone, day, matchupId, initialDate])
    const [selection, setSelection] = useState({ identity, date: initialDate ?? todayLeague(timezone) })
    if (selection.identity !== identity) setSelection({ identity, date: initialDate ?? day })
    const requestedDate = selection.identity === identity ? selection.date : initialDate ?? day
    const view = useScreenView<HomePayload>(current && user && league ? screenScope('home', league.id, current.id, { date: requestedDate, ...(matchupId ? { matchupId } : {}) }, user.id) : null, focused && membershipValidated && !membershipError)
    const refreshView = view.refresh
    const data = view.data
    const matchup = data?.matchup ?? null
    const selectedDate = data?.selectedDate ?? requestedDate
    const matchupRef = useRef(matchup)
    matchupRef.current = matchup
    const setSelectedDate = useCallback((date: string) => setSelection({ identity, date }), [identity])
    const refresh = useCallback(async () => { if (todayLeague(timezone) !== day) { setDay(todayLeague(timezone)); return }; if (membershipError) await refreshMemberships?.(); await refreshView(true) }, [day, timezone, setDay, membershipError, refreshMemberships, refreshView])
    const latestSelection = useRef({ identity, date: requestedDate })
    latestSelection.current = { identity, date: requestedDate }
    const loadMyLineup = useCallback(async (_matchup: MatchupContext, date: string) => { if (latestSelection.current.identity !== identity || latestSelection.current.date !== date) return false; return refreshView(true) }, [identity, refreshView])
    const loadLineups = loadMyLineup
    const refreshSilently = useCallback(async () => { if (todayLeague(timezone) !== day) { setDay(todayLeague(timezone)); return false }; return refreshView(false, false) }, [day, timezone, setDay, refreshView])
    const gameTimes = useMatchupGameTimes(data?.todaysGames ?? [], (data?.context as HomePayload['context'] & { league?: { timezone?: string } })?.league?.timezone ?? timezone)
    const displayMatchups = useMemo(() => {
        const matchups = new Map<string, MatchupGame>(Object.entries(data?.teamMatchups ?? {}))
        for (const game of data?.todaysGames ?? []) {
            const info = { gameTime: gameTimes?.values.get(game.id), status: game.status, timezone: gameTimes?.timezone }
            matchups.set(game.home_team, { opponent: game.away_team, isHome: true, ...info })
            matchups.set(game.away_team, { opponent: game.home_team, isHome: false, ...info })
        }
        return matchups
    }, [data, gameTimes])
    const gameSnapshot = useMemo(() => ({ todaysGames: data?.todaysGames ?? [], liveStats: new Map(Object.entries(data?.liveStats ?? {})), startedTeams: new Set(data?.startedTeams ?? []), teamMatchups: displayMatchups, freshness: view.offline ? 'offline' as const : data ? 'fresh' as const : 'refreshing' as const }), [data, displayMatchups, view.offline])
    const announcements = useMemo(() => ({ announcements: data?.announcements ?? [], loaded: view.loaded || Boolean(view.error), refreshing: view.refreshing, refresh }), [data, view.loaded, view.error, view.refreshing, refresh])
    const forecastState = useMemo(() => ({ forecast: data?.forecast ?? null, pending: view.loading, error: Boolean(view.error), stale: data?.forecast?.stale === true || view.offline || view.refreshing }), [data, view.loading, view.error, view.offline, view.refreshing])
    return { timezone: gameTimes?.timezone, emptyConfirmed: data?.matchup === null && !membershipError, matchup, leagueMatchups: data?.leagueMatchups ?? [], weekDays: data?.weekDays ?? [], selectedDate, setSelectedDate, myLineup: data?.myLineup ?? null, oppLineup: data?.oppLineup ?? null, matchupLoading: !membershipError && view.loading, matchupRefreshing: view.refreshing, lineupLoading: view.loading, lineupError: Boolean(view.error), error: membershipError?.message ?? view.error?.message ?? null, refresh, loadMyLineup, loadLineups, refreshSilently, matchupRef, announcements, forecastState, liveSnapshot: gameSnapshot }
}
