import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getLeagueWeekMatchups, getMyMatchup, LeagueWeekMatchup, Matchup } from '@/lib/scoring'
import { clampDateToWeek, getWeekDays, getWeeklyLineup, LineupSlot, LineupPlayer, WeekDay } from '@/lib/lineup'
import { todayET } from '@/lib/shared/dates'
import { supabase } from '@/lib/supabase'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }
type LineupPair = { mine: LineupData; opp: LineupData }
type MatchupScreenCache = {
    today: string
    selectedDate: string
    matchup: Matchup | null
    weekDays: WeekDay[]
    leagueMatchups: LeagueWeekMatchup[]
    myLineup: LineupData | null
    oppLineup: LineupData | null
}

const MATCHUP_CACHE_PREFIX = 'pancake:home-matchup:v1:'

function matchupCacheKey(memberId: string, leagueId: string) {
    return `${MATCHUP_CACHE_PREFIX}${leagueId}:${memberId}`
}

function readMatchupCache(memberId: string | undefined, leagueId: string | undefined): MatchupScreenCache | undefined {
    if (!memberId || !leagueId) return undefined
    const cached = readPersistentCache<MatchupScreenCache>(matchupCacheKey(memberId, leagueId))
    if (!cached || cached.today !== todayET()) return undefined
    return cached
}

function writeMatchupCache(memberId: string, leagueId: string, value: Omit<MatchupScreenCache, 'today'>) {
    writePersistentCache<MatchupScreenCache>(matchupCacheKey(memberId, leagueId), {
        today: todayET(),
        ...value,
    })
}

export function useMatchupData(
    current: { id: string } | null,
    user: { id: string } | null,
    league: { id: string } | null,
) {
    const leagueId = league?.id
    const initialCacheRef = useRef<{ loaded: boolean; value?: MatchupScreenCache }>({ loaded: false })
    if (!initialCacheRef.current.loaded) {
        initialCacheRef.current = { loaded: true, value: readMatchupCache(current?.id, leagueId) }
    }
    const initialCache = initialCacheRef.current.value
    const [matchup, setMatchup] = useState<Matchup | null | undefined>(initialCache?.matchup ?? undefined)
    const [weekDays, setWeekDays] = useState<WeekDay[]>(initialCache?.weekDays ?? [])
    // selectedDate flows into getWeeklyLineup queries that compare against
    // weekly_lineups.game_date (ET-keyed). Use todayET so non-ET clients
    // don't query against the wrong date.
    const [selectedDate, setSelectedDate] = useState<string>(() => initialCache?.selectedDate ?? todayET())
    const [leagueMatchups, setLeagueMatchups] = useState<LeagueWeekMatchup[]>(initialCache?.leagueMatchups ?? [])
    const [myLineup, setMyLineup] = useState<LineupData | null>(initialCache?.myLineup ?? null)
    const [oppLineup, setOppLineup] = useState<LineupData | null>(initialCache?.oppLineup ?? null)
    const [matchupLoading, setMatchupLoading] = useState(!initialCache)
    const [lineupLoading, setLineupLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const matchupRef = useRef<Matchup | null>(initialCache?.matchup ?? null)
    const isFirstRunRef = useRef(true)
    const loadSeqRef = useRef(0)

    useEffect(() => {
        if (isFirstRunRef.current) {
            isFirstRunRef.current = false
            return
        }
        const cached = readMatchupCache(current?.id, leagueId)
        setMatchup(cached?.matchup ?? undefined)
        setWeekDays(cached?.weekDays ?? [])
        setLeagueMatchups(cached?.leagueMatchups ?? [])
        setMyLineup(cached?.myLineup ?? null)
        setOppLineup(cached?.oppLineup ?? null)
        setSelectedDate(cached?.selectedDate ?? todayET())
        setMatchupLoading(!cached)
        matchupRef.current = cached?.matchup ?? null
    }, [current?.id, leagueId])

    const loadLineups = useCallback(
        async (m: Matchup, date: string): Promise<LineupPair | null> => {
            if (!leagueId) return null
            // Inherit the in-flight load token so a league switch mid-fetch can't
            // commit the previous league's starters/bench (last-writer-wins).
            const seq = loadSeqRef.current
            setLineupLoading(true)
            try {
                const [mine, opp] = await Promise.all([
                    getWeeklyLineup(m.myMemberId, leagueId, m.seasonId, m.weekNumber, date),
                    getWeeklyLineup(m.opponentMemberId, leagueId, m.seasonId, m.weekNumber, date),
                ])
                if (seq !== loadSeqRef.current) return null
                setMyLineup(mine)
                setOppLineup(opp)
                return { mine, opp }
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
        const hasVisibleMatchup = matchupRef.current != null
        setMatchupLoading(!hasVisibleMatchup)
        if (!hasVisibleMatchup) {
            setMyLineup(null)
            setOppLineup(null)
        }
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
                const selected = clampDateToWeek(today, days)
                setWeekDays(days)
                setLeagueMatchups(weekMatchups)
                setSelectedDate(selected)
                const lineups = await loadLineups(m, selected)
                if (seq !== loadSeqRef.current) return
                writeMatchupCache(current.id, leagueId, {
                    selectedDate: selected,
                    matchup: m,
                    weekDays: days,
                    leagueMatchups: weekMatchups,
                    myLineup: lineups?.mine ?? null,
                    oppLineup: lineups?.opp ?? null,
                })
            } else {
                setWeekDays([])
                setLeagueMatchups([])
                setMyLineup(null)
                setOppLineup(null)
                setSelectedDate(todayET())
                writeMatchupCache(current.id, leagueId, {
                    selectedDate: todayET(),
                    matchup: null,
                    weekDays: [],
                    leagueMatchups: [],
                    myLineup: null,
                    oppLineup: null,
                })
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
