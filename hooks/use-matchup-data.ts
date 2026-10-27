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
import { endOfETDayUTC, todayET } from '@/lib/shared/dates'

type HomePayload = HomeView & { forecast: MatchupForecast | null; announcements: LeagueAnnouncement[]; todaysGames: NBAGameRow[]; liveStats: Record<string, LiveStatLine>; startedTeams: string[]; teamMatchups: Record<string, { opponent: string; isHome: boolean }> }

export function useMatchupData(current: { id: string; team_name?: string | null; role?: string } | null, user: { id: string } | null, league: Pick<LeagueInfo, 'id'> & Partial<LeagueInfo> | null, membershipValidated = true, membershipError: Error | null = null, refreshMemberships?: () => Promise<void>) {
    const focused = useIsFocused()
    const [day, setDay] = useState(todayET)
    useEffect(() => {
        const update = () => setDay(todayET())
        const timer = setTimeout(update, Math.max(1, Date.parse(endOfETDayUTC(day)) - Date.now() + 1))
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
    }, [day])
    const identity = JSON.stringify([user?.id, league?.id, current?.id, day])
    const [selection, setSelection] = useState({ identity, date: todayET() })
    const requestedDate = selection.identity === identity ? selection.date : day
    const view = useScreenView<HomePayload>(current && user && league ? screenScope('home', league.id, current.id, { date: requestedDate }, user.id) : null, focused && membershipValidated && !membershipError)
    const refreshView = view.refresh
    const data = view.data
    const matchup = data?.matchup ?? null
    const selectedDate = data?.selectedDate ?? requestedDate
    const matchupRef = useRef(matchup)
    matchupRef.current = matchup
    const setSelectedDate = useCallback((date: string) => setSelection({ identity, date }), [identity])
    const refresh = useCallback(async () => { if (todayET() !== day) { setDay(todayET()); return }; if (membershipError) await refreshMemberships?.(); await refreshView(true) }, [day, membershipError, refreshMemberships, refreshView])
    const latestSelection = useRef({ identity, date: requestedDate })
    latestSelection.current = { identity, date: requestedDate }
    const loadMyLineup = useCallback(async (_matchup: MatchupContext, date: string) => { if (latestSelection.current.identity !== identity || latestSelection.current.date !== date) return false; return refreshView(true) }, [identity, refreshView])
    const loadLineups = loadMyLineup
    const refreshSilently = useCallback(async () => { if (todayET() !== day) { setDay(todayET()); return false }; return refreshView(false, false) }, [day, refreshView])
    const gameSnapshot = useMemo(() => ({ todaysGames: data?.todaysGames ?? [], liveStats: new Map(Object.entries(data?.liveStats ?? {})), startedTeams: new Set(data?.startedTeams ?? []), teamMatchups: new Map(Object.entries(data?.teamMatchups ?? {})), freshness: view.offline ? 'offline' as const : data ? 'fresh' as const : 'refreshing' as const }), [data, view.offline])
    const announcements = useMemo(() => ({ announcements: data?.announcements ?? [], loaded: view.loaded || Boolean(view.error), refreshing: view.refreshing, refresh }), [data, view.loaded, view.error, view.refreshing, refresh])
    const forecastState = useMemo(() => ({ forecast: data?.forecast ?? null, pending: view.loading, error: Boolean(view.error), stale: data?.forecast?.stale === true || view.offline || view.refreshing }), [data, view.loading, view.error, view.offline, view.refreshing])
    return { emptyConfirmed: data?.matchup === null && !membershipError, matchup, leagueMatchups: data?.leagueMatchups ?? [], weekDays: data?.weekDays ?? [], selectedDate, setSelectedDate, myLineup: data?.myLineup ?? null, oppLineup: data?.oppLineup ?? null, matchupLoading: !membershipError && view.loading, matchupRefreshing: view.refreshing, lineupLoading: view.loading, lineupError: Boolean(view.error), error: membershipError?.message ?? view.error?.message ?? null, refresh, loadMyLineup, loadLineups, refreshSilently, matchupRef, announcements, forecastState, liveSnapshot: gameSnapshot }
}
