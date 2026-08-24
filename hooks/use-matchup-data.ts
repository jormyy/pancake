import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getLeagueWeekMatchups, getMyMatchup, LeagueWeekMatchup, Matchup } from '@/lib/scoring'
import { clampDateToWeek, getWeekDays, getWeeklyLineup, invalidateCachedRoster, LineupSlot, LineupPlayer, WeekDay } from '@/lib/lineup'
import { todayET } from '@/lib/shared/dates'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { invalidateWeekNumberCache } from '@/lib/shared/week'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useOnlineStatus } from '@/hooks/use-online-status'
import {
    debounceRealtimeRefresh,
    disposeTableChangeSubscription,
    reportRealtimeCleanup,
    subscribeToTableChanges,
} from '@/lib/realtime'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; ir: LineupPlayer[]; taxi: LineupPlayer[] }
type LineupPair = { mine: LineupData; opp: LineupData }
type MatchupRealtimeRow = {
    id: string
    week_number: number
    home_member_id: string
    home_points: number | null
    away_points: number | null
    is_finalized: boolean
    winner_member_id: string | null
}
type WeeklyLineupRealtimeRow = { week_number: number; game_date: string; member_id: string }
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

function isMatchupRealtimeRow(row: object): row is MatchupRealtimeRow {
    return 'id' in row && typeof row.id === 'string'
        && 'week_number' in row && typeof row.week_number === 'number'
        && 'home_member_id' in row && typeof row.home_member_id === 'string'
        && 'home_points' in row && (typeof row.home_points === 'number' || row.home_points === null)
        && 'away_points' in row && (typeof row.away_points === 'number' || row.away_points === null)
        && 'is_finalized' in row && typeof row.is_finalized === 'boolean'
        && 'winner_member_id' in row && (typeof row.winner_member_id === 'string' || row.winner_member_id === null)
}

function isWeeklyLineupRealtimeRow(row: object): row is WeeklyLineupRealtimeRow {
    return 'week_number' in row && typeof row.week_number === 'number'
        && 'game_date' in row && typeof row.game_date === 'string'
        && 'member_id' in row && typeof row.member_id === 'string'
}

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
    const online = useOnlineStatus()
    const wasOnlineRef = useRef(online)
    const leagueId = league?.id
    const resourceKey = current && user && leagueId
        ? `${user.id}:${leagueId}:${current.id}`
        : null
    const activeResourceKeyRef = useRef(resourceKey)
    activeResourceKeyRef.current = resourceKey
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
    const [selectedDate, setSelectedDateState] = useState<string>(() => initialCache?.selectedDate ?? todayET())
    const selectedDateRef = useRef(selectedDate)
    const setSelectedDate = useCallback((date: string) => {
        selectedDateRef.current = date
        setSelectedDateState(date)
    }, [])
    const [leagueMatchups, setLeagueMatchups] = useState<LeagueWeekMatchup[]>(initialCache?.leagueMatchups ?? [])
    const [myLineup, setMyLineup] = useState<LineupData | null>(initialCache?.myLineup ?? null)
    const [oppLineup, setOppLineup] = useState<LineupData | null>(initialCache?.oppLineup ?? null)
    const [matchupLoading, setMatchupLoading] = useState(!initialCache)
    const [lineupLoading, setLineupLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [dataOwnerKey, setDataOwnerKey] = useState(resourceKey)
    const matchupRef = useRef<Matchup | null>(initialCache?.matchup ?? null)
    const exposedMatchupRef = useRef<Matchup | null>(initialCache?.matchup ?? null)
    const isFirstRunRef = useRef(true)
    const loadSeqRef = useRef(0)
    const lineupSeqRef = useRef(0)

    useEffect(() => {
        if (isFirstRunRef.current) {
            isFirstRunRef.current = false
            return
        }
        loadSeqRef.current += 1
        lineupSeqRef.current += 1
        const cached = readMatchupCache(current?.id, leagueId)
        setMatchup(cached?.matchup ?? undefined)
        setWeekDays(cached?.weekDays ?? [])
        setLeagueMatchups(cached?.leagueMatchups ?? [])
        setMyLineup(cached?.myLineup ?? null)
        setOppLineup(cached?.oppLineup ?? null)
        setSelectedDate(cached?.selectedDate ?? todayET())
        setMatchupLoading(!cached)
        setLineupLoading(false)
        setError(null)
        matchupRef.current = cached?.matchup ?? null
        setDataOwnerKey(resourceKey)
    }, [current?.id, leagueId, resourceKey, setSelectedDate])

    const ownsResource = dataOwnerKey === resourceKey
    exposedMatchupRef.current = ownsResource ? matchupRef.current : null

    const fetchLineups = useCallback(
        async (m: Matchup, date: string, currentLeagueId: string): Promise<LineupPair> => {
            const [mine, opp] = await Promise.all([
                getWeeklyLineup(m.myMemberId, currentLeagueId, m.seasonId, m.weekNumber, date),
                getWeeklyLineup(m.opponentMemberId, currentLeagueId, m.seasonId, m.weekNumber, date),
            ])
            return { mine, opp }
        },
        [],
    )

    const loadLineups = useCallback(
        async (m: Matchup, date: string): Promise<LineupPair | null> => {
            const capturedResourceKey = resourceKey
            if (!capturedResourceKey || !ownsResource || !leagueId || date !== selectedDateRef.current) return null
            const seq = ++lineupSeqRef.current
            const currentLeagueId = leagueId
            setLineupLoading(true)
            try {
                const lineups = await fetchLineups(m, date, currentLeagueId)
                if (seq !== lineupSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey ||
                    date !== selectedDateRef.current) return null
                setMyLineup(lineups.mine)
                setOppLineup(lineups.opp)
                return lineups
            } finally {
                if (seq === lineupSeqRef.current) setLineupLoading(false)
            }
        },
        [fetchLineups, leagueId, ownsResource, resourceKey],
    )

    const loadMyLineup = useCallback(
        async (m: Matchup, date: string) => {
            const capturedResourceKey = resourceKey
            if (!capturedResourceKey || !ownsResource || !leagueId || date !== selectedDateRef.current) return
            const seq = ++lineupSeqRef.current
            const currentLeagueId = leagueId
            const data = await getWeeklyLineup(m.myMemberId, currentLeagueId, m.seasonId, m.weekNumber, date)
            if (seq !== lineupSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey ||
                date !== selectedDateRef.current) return
            setMyLineup(data)
        },
        [leagueId, ownsResource, resourceKey],
    )

    const refreshSilently = useCallback(
        async () => {
            const m = matchupRef.current
            const capturedResourceKey = resourceKey
            if (!capturedResourceKey || !ownsResource || !m || !leagueId) return
            const seq = ++lineupSeqRef.current
            const currentLeagueId = leagueId
            const date = selectedDateRef.current
            const [mine, opp] = await Promise.all([
                getWeeklyLineup(m.myMemberId, currentLeagueId, m.seasonId, m.weekNumber, date, { allowCachedStatics: true }),
                getWeeklyLineup(m.opponentMemberId, currentLeagueId, m.seasonId, m.weekNumber, date, { allowCachedStatics: true }),
            ])
            if (seq !== lineupSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey ||
                date !== selectedDateRef.current) return
            setMyLineup(mine)
            setOppLineup(opp)
        },
        [leagueId, ownsResource, resourceKey],
    )

    const load = useCallback(async () => {
        const capturedResourceKey = resourceKey
        if (!capturedResourceKey || !current || !user || !leagueId) return
        // Sequence concurrent loads (league switch / focus) so a slower fetch for
        // a previous league can never overwrite the current league's matchup.
        const seq = ++loadSeqRef.current
        lineupSeqRef.current += 1
        const hasVisibleMatchup = matchupRef.current != null
        setMatchupLoading(!hasVisibleMatchup)
        if (!hasVisibleMatchup) {
            setMyLineup(null)
            setOppLineup(null)
        }
        try {
            setError(null)
            const m = await getMyMatchup(current.id, leagueId)
            if (seq !== loadSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey) return
            if (m) {
                const today = todayET()
                // Optimistically fetch today's lineups alongside week metadata —
                // during the season the clamped date IS today, so the lineup wave
                // overlaps the metadata wave instead of queuing behind it.
                const [days, weekMatchups, todayLineups] = await Promise.all([
                    getWeekDays(m.weekNumber, m.seasonYear),
                    getLeagueWeekMatchups(leagueId, m.seasonId, m.weekNumber, m.myMemberId),
                    fetchLineups(m, today, leagueId),
                ])
                if (seq !== loadSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey) return
                const selected = clampDateToWeek(today, days)
                const lineups = selected === today ? todayLineups : await fetchLineups(m, selected, leagueId)
                if (seq !== loadSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey) return
                setMatchup(m)
                matchupRef.current = m
                setWeekDays(days)
                setLeagueMatchups(weekMatchups)
                setSelectedDate(selected)
                setMyLineup(lineups.mine)
                setOppLineup(lineups.opp)
                writeMatchupCache(current.id, leagueId, {
                    selectedDate: selected,
                    matchup: m,
                    weekDays: days,
                    leagueMatchups: weekMatchups,
                    myLineup: lineups.mine,
                    oppLineup: lineups.opp,
                })
            } else {
                setMatchup(null)
                matchupRef.current = null
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
            if (seq !== loadSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey) return
            console.error(e)
            setError('Failed to load matchup')
        } finally {
            if (seq === loadSeqRef.current && activeResourceKeyRef.current === capturedResourceKey) {
                setMatchupLoading(false)
            }
        }
    }, [current, user, leagueId, fetchLineups, resourceKey, setSelectedDate])

    useFocusEffect(useCallback(() => { load() }, [load]))

    useEffect(() => {
        const wasOnline = wasOnlineRef.current
        wasOnlineRef.current = online
        if (!wasOnline && online && leagueId) {
            invalidateSeasonCache(leagueId)
            invalidateWeekNumberCache()
            void load()
        }
    }, [leagueId, load, online])

    useEffect(() => {
        if (!ownsResource || !matchup?.id) return
        const refreshVisibleLineups = debounceRealtimeRefresh(() => { void refreshSilently() }, 200)
        const visibleMemberIds = new Set([matchup.myMemberId, matchup.opponentMemberId])
        const channel = subscribeToTableChanges(
            `league-matchups:${matchup.seasonId}:${matchup.weekNumber}`,
            {
                mode: 'per-watch',
                watches: [{
                    event: 'UPDATE',
                    table: 'matchups',
                    filter: `league_season_id=eq.${matchup.seasonId}`,
                    onChange: (payload) => {
                        if (!isMatchupRealtimeRow(payload.new)) return
                        const row = payload.new
                        const { home_points, away_points, is_finalized, winner_member_id } = row
                        if (row.week_number !== matchup.weekNumber) return
                        if (row.id === matchup.id) {
                            setMatchup((prev) => {
                                if (!prev) return prev
                                const isHome = prev.myMemberId === row.home_member_id
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
                                item.id === row.id
                                    ? {
                                          ...item,
                                          homePoints: home_points != null ? Number(home_points) : null,
                                          awayPoints: away_points != null ? Number(away_points) : null,
                                          isFinalized: is_finalized,
                                      }
                                    : item,
                            ),
                        )
                    },
                }, {
                    table: 'weekly_lineups',
                    filter: `league_season_id=eq.${matchup.seasonId}`,
                    onChange: (payload) => {
                        const row = payload.eventType === 'DELETE' ? payload.old : payload.new
                        if (!isWeeklyLineupRealtimeRow(row)) return
                        if (row.week_number !== matchup.weekNumber) return
                        // Read the date from a ref so day-taps don't tear down and
                        // rebuild the whole realtime channel (websocket rejoin).
                        if (row.game_date !== selectedDateRef.current) return
                        if (!visibleMemberIds.has(row.member_id)) return
                        if (leagueId) invalidateCachedRoster(row.member_id, leagueId, matchup.seasonId)
                        refreshVisibleLineups.trigger()
                    },
                }],
            },
        )

        return () => {
            reportRealtimeCleanup(
                'matchup',
                disposeTableChangeSubscription(channel, [refreshVisibleLineups]),
            )
        }
    }, [matchup?.id, matchup?.seasonId, matchup?.weekNumber, matchup?.myMemberId, matchup?.opponentMemberId, ownsResource, refreshSilently, resourceKey, leagueId])

    const setVisibleSelectedDate = useCallback((date: string) => {
        if (ownsResource && activeResourceKeyRef.current === resourceKey) setSelectedDate(date)
    }, [ownsResource, resourceKey, setSelectedDate])

    return {
        matchup: ownsResource ? matchup : undefined,
        leagueMatchups: ownsResource ? leagueMatchups : [],
        weekDays: ownsResource ? weekDays : [],
        selectedDate: ownsResource ? selectedDate : todayET(),
        setSelectedDate: setVisibleSelectedDate,
        myLineup: ownsResource ? myLineup : null,
        setMyLineup,
        oppLineup: ownsResource ? oppLineup : null,
        matchupLoading: ownsResource ? matchupLoading : true,
        lineupLoading: ownsResource ? lineupLoading : false,
        error: ownsResource ? error : null,
        refresh: load,
        loadMyLineup,
        loadLineups,
        refreshSilently,
        matchupRef: exposedMatchupRef,
    }
}
