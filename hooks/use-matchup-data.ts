import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getMyMatchup, Matchup } from '@/lib/scoring'
import { getWeekDays, getWeeklyLineup, LineupSlot, LineupPlayer, WeekDay } from '@/lib/lineup'
import { todayDateString } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[] }

export function useMatchupData(current: any, user: any, league: any) {
    const [matchup, setMatchup] = useState<Matchup | null | undefined>(undefined)
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [selectedDate, setSelectedDate] = useState<string>(() => todayDateString())
    const [myLineup, setMyLineup] = useState<LineupData | null>(null)
    const [oppLineup, setOppLineup] = useState<LineupData | null>(null)
    const [matchupLoading, setMatchupLoading] = useState(true)
    const [lineupLoading, setLineupLoading] = useState(false)
    const matchupRef = useRef<Matchup | null>(null)

    const loadLineups = useCallback(
        async (m: Matchup, date: string) => {
            setLineupLoading(true)
            try {
                const [mine, opp] = await Promise.all([
                    getWeeklyLineup(m.myMemberId, league?.id, m.seasonId, m.weekNumber, date),
                    getWeeklyLineup(m.opponentMemberId, league?.id, m.seasonId, m.weekNumber, date),
                ])
                setMyLineup(mine)
                setOppLineup(opp)
            } finally {
                setLineupLoading(false)
            }
        },
        [league?.id],
    )

    const loadMyLineup = useCallback(
        async (m: Matchup, date: string) => {
            const data = await getWeeklyLineup(m.myMemberId, league?.id, m.seasonId, m.weekNumber, date)
            setMyLineup(data)
        },
        [league?.id],
    )

    // Silently refreshes both lineups without showing a loading spinner (used by background polls)
    const refreshSilently = useCallback(
        async () => {
            const m = matchupRef.current
            if (!m) return
            const [mine, opp] = await Promise.all([
                getWeeklyLineup(m.myMemberId, league?.id, m.seasonId, m.weekNumber, selectedDate),
                getWeeklyLineup(m.opponentMemberId, league?.id, m.seasonId, m.weekNumber, selectedDate),
            ])
            setMyLineup(mine)
            setOppLineup(opp)
        },
        [league?.id, selectedDate],
    )

    const load = useCallback(async () => {
        if (!current || !user) return
        setMatchupLoading(true)
        setMyLineup(null)
        setOppLineup(null)
        try {
            const m = await getMyMatchup((current as any).id, league.id)
            setMatchup(m)
            matchupRef.current = m
            if (m) {
                const today = todayDateString()
                const days = await getWeekDays(m.weekNumber, m.seasonYear)
                setWeekDays(days)
                setSelectedDate(today)
                await loadLineups(m, today)
            }
        } catch (e) {
            console.error(e)
            setMatchup(null)
        } finally {
            setMatchupLoading(false)
        }
    }, [current, user, loadLineups])

    useFocusEffect(useCallback(() => { load() }, [load]))

    useEffect(() => {
        if (!matchup?.id) return
        const channel = supabase
            .channel(`matchup_${matchup.id}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'matchups',
                filter: `id=eq.${matchup.id}`,
            }, (payload) => {
                const { home_points, away_points, is_finalized, winner_member_id } = payload.new
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
            })
            .subscribe()

        return () => { supabase.removeChannel(channel) }
    }, [matchup?.id])

    return {
        matchup,
        weekDays,
        selectedDate,
        setSelectedDate,
        myLineup,
        setMyLineup,
        oppLineup,
        matchupLoading,
        lineupLoading,
        refresh: load,
        loadMyLineup,
        loadLineups,
        refreshSilently,
        matchupRef,
    }
}
