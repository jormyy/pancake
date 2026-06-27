import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getLeagueWeekMatchups, getMyMatchup, LeagueWeekMatchup, Matchup } from '@/lib/scoring'
import { getWeekDays, getWeeklyLineup, LineupSlot, LineupPlayer, WeekDay } from '@/lib/lineup'
import { todayET } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }

export function useMatchupData(
    current: { id: string } | null,
    user: { id: string } | null,
    league: { id: string } | null,
) {
    const [matchup, setMatchup] = useState<Matchup | null | undefined>(undefined)
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    // selectedDate flows into getWeeklyLineup queries that compare against
    // weekly_lineups.game_date (ET-keyed). Use todayET so non-ET clients
    // don't query against the wrong date.
    const [selectedDate, setSelectedDate] = useState<string>(() => todayET())
    const [leagueMatchups, setLeagueMatchups] = useState<LeagueWeekMatchup[]>([])
    const [myLineup, setMyLineup] = useState<LineupData | null>(null)
    const [oppLineup, setOppLineup] = useState<LineupData | null>(null)
    const [matchupLoading, setMatchupLoading] = useState(true)
    const [lineupLoading, setLineupLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const matchupRef = useRef<Matchup | null>(null)
    const isFirstRunRef = useRef(true)
    const loadSeqRef = useRef(0)

    const leagueId = league?.id

    useEffect(() => {
        if (isFirstRunRef.current) {
            isFirstRunRef.current = false
            return
        }
        setMatchup(undefined)
        setLeagueMatchups([])
        setMyLineup(null)
        setOppLineup(null)
        setMatchupLoading(true)
        matchupRef.current = null
    }, [current?.id, leagueId])

    const loadLineups = useCallback(
        async (m: Matchup, date: string) => {
            if (!leagueId) return
            // Inherit the in-flight load token so a league switch mid-fetch can't
            // commit the previous league's starters/bench (last-writer-wins).
            const seq = loadSeqRef.current
            setLineupLoading(true)
            try {
                const [mine, opp] = await Promise.all([
                    getWeeklyLineup(m.myMemberId, leagueId, m.seasonId, m.weekNumber, date),
                    getWeeklyLineup(m.opponentMemberId, leagueId, m.seasonId, m.weekNumber, date),
                ])
                if (seq !== loadSeqRef.current) return
                setMyLineup(mine)
                setOppLineup(opp)
            } finally {
                if (seq === loadSeqRef.current) setLineupLoading(false)
            }
        },
        [leagueId],
    )

    const loadMyLineup = useCallback(
        async (m: Matchup, date: string) => {
            if (!leagueId) return
            const seq = loadSeqRef.current
            const data = await getWeeklyLineup(m.myMemberId, leagueId, m.seasonId, m.weekNumber, date)
            if (seq !== loadSeqRef.current) return
            setMyLineup(data)
        },
        [leagueId],
    )

    const refreshSilently = useCallback(
        async () => {
            const m = matchupRef.current
            if (!m || !leagueId) return
            const seq = loadSeqRef.current
            const [mine, opp] = await Promise.all([
                getWeeklyLineup(m.myMemberId, leagueId, m.seasonId, m.weekNumber, selectedDate),
                getWeeklyLineup(m.opponentMemberId, leagueId, m.seasonId, m.weekNumber, selectedDate),
            ])
            if (seq !== loadSeqRef.current) return
            setMyLineup(mine)
            setOppLineup(opp)
        },
        [leagueId, selectedDate],
    )

    const load = useCallback(async () => {
        if (!current || !user || !leagueId) return
        // Sequence concurrent loads (league switch / focus) so a slower fetch for
        // a previous league can never overwrite the current league's matchup.
        const seq = ++loadSeqRef.current
        setMatchupLoading(true)
        setMyLineup(null)
        setOppLineup(null)
        try {
            setError(null)
            const m = await getMyMatchup(current.id, leagueId)
            if (seq !== loadSeqRef.current) return
            setMatchup(m)
            matchupRef.current = m
            if (m) {
                // ET-keyed: flows into getWeeklyLineup query against weekly_lineups.game_date
                const today = todayET()
                const [days, weekMatchups] = await Promise.all([
                    getWeekDays(m.weekNumber, m.seasonYear),
                    getLeagueWeekMatchups(leagueId, m.seasonId, m.weekNumber, m.myMemberId),
                ])
                if (seq !== loadSeqRef.current) return
                setWeekDays(days)
                setLeagueMatchups(weekMatchups)
                setSelectedDate(today)
                await loadLineups(m, today)
            }
        } catch (e) {
            if (seq !== loadSeqRef.current) return
            console.error(e)
            setMatchup(null)
            setError('Failed to load matchup')
        } finally {
            if (seq === loadSeqRef.current) setMatchupLoading(false)
        }
    }, [current, user, leagueId, loadLineups])

    useFocusEffect(useCallback(() => { load() }, [load]))

    useEffect(() => {
        if (!matchup?.id) return
        const channel = supabase
            .channel(`league_matchups_${matchup.seasonId}_${matchup.weekNumber}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'matchups',
                filter: `league_season_id=eq.${matchup.seasonId}`,
            }, (payload) => {
                const { home_points, away_points, is_finalized, winner_member_id } = payload.new
                if (payload.new.week_number !== matchup.weekNumber) return
                if (payload.new.id === matchup.id) {
                    setMatchup((prev) => {
                        if (!prev) return prev
                        const isHome = prev.myMemberId === payload.new.home_member_id
                        return {
                            ...prev,
                            myPoints: isHome ? home_points : away_points,
                            opponentPoints: isHome ? away_points : home_points,
                            isFinalized: is_finalized,
                            iWon: winner_member_id ? winner_member_id === prev.myMemberId : null,
                        }
                    })
                }
                setLeagueMatchups((prev) =>
                    prev.map((item) =>
                        item.id === payload.new.id
                            ? {
                                  ...item,
                                  homePoints: home_points != null ? Number(home_points) : null,
                                  awayPoints: away_points != null ? Number(away_points) : null,
                                  isFinalized: is_finalized,
                              }
                            : item,
                    ),
                )
            })
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [matchup?.id, matchup?.seasonId, matchup?.weekNumber])

    return {
        matchup,
        leagueMatchups,
        weekDays,
        selectedDate,
        setSelectedDate,
        myLineup,
        setMyLineup,
        oppLineup,
        matchupLoading,
        lineupLoading,
        error,
        refresh: load,
        loadMyLineup,
        loadLineups,
        refreshSilently,
        matchupRef,
    }
}
