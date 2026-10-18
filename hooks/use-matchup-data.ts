import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { getLeagueWeekMatchups, getMyMatchup, LeagueWeekMatchup, Matchup } from '@/lib/scoring'
import { clampDateToWeek, getWeekDays, getWeeklyLineup, invalidateCachedRoster, LineupSlot, LineupPlayer, WeekDay } from '@/lib/lineup'
import { deferLeagueRefresh, leagueChangeAffects, listenForLeagueChanges } from '@/lib/league-changes'
import { todayET } from '@/lib/shared/dates'
import { invalidateSeasonCache } from '@/lib/shared/season'
import { getSeasonWeekDates, invalidateWeekNumberCache } from '@/lib/shared/week'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { useOnlineStatus } from '@/hooks/use-online-status'
import {
    disposeTableChangeSubscription,
    reportRealtimeCleanup,
    subscribeToTableChanges,
} from '@/lib/realtime'

type LineupData = { starters: LineupSlot[]; bench: LineupPlayer[]; benchSlots?: number; ir: LineupPlayer[]; taxi: LineupPlayer[] }
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

function lineupScope(matchup: Matchup | null | undefined, date: string): string | null {
    return matchup ? `${matchup.seasonId}:${matchup.id}:${matchup.weekNumber}:${date}` : null
}

function reuseLineup(previous: LineupData | null, next: LineupData): LineupData {
    return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

function isMatchupRealtimeRow(row: object): row is MatchupRealtimeRow {
    return 'id' in row && typeof row.id === 'string'
        && 'week_number' in row && typeof row.week_number === 'number'
        && 'home_member_id' in row && typeof row.home_member_id === 'string'
        && 'home_points' in row && (typeof row.home_points === 'number' || row.home_points === null)
        && 'away_points' in row && (typeof row.away_points === 'number' || row.away_points === null)
        && 'is_finalized' in row && typeof row.is_finalized === 'boolean'
        && 'winner_member_id' in row && (typeof row.winner_member_id === 'string' || row.winner_member_id === null)
}


function matchupCacheKey(memberId: string, leagueId: string) {
    return `${MATCHUP_CACHE_PREFIX}${leagueId}:${memberId}`
}

function readMatchupCache(memberId: string | undefined, leagueId: string | undefined): MatchupScreenCache | undefined {
    if (!memberId || !leagueId) return undefined
    const cached = readPersistentCache<MatchupScreenCache>(matchupCacheKey(memberId, leagueId))
    if (!cached || cached.today !== todayET()) return undefined
    for (const lineup of [cached.myLineup, cached.oppLineup]) {
        if (lineup && (typeof lineup.benchSlots !== 'number' || !Number.isSafeInteger(lineup.benchSlots) || lineup.benchSlots < 0)) return undefined
    }
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
    membershipValidated = true,
    membershipError: Error | null = null,
    refreshMemberships?: () => Promise<void>,
) {
    const membershipValidatedRef = useRef(membershipValidated)
    membershipValidatedRef.current = membershipValidated
    const membershipErrorRef = useRef(membershipError)
    membershipErrorRef.current = membershipError
    const refreshMembershipsRef = useRef(refreshMemberships)
    refreshMembershipsRef.current = refreshMemberships
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
    const [myLineupScope, setMyLineupScope] = useState(() => lineupScope(initialCache?.matchup, selectedDate))
    const [oppLineupScope, setOppLineupScope] = useState(() => lineupScope(initialCache?.matchup, selectedDate))
    const [matchupLoading, setMatchupLoading] = useState(!initialCache)
    const [lineupLoading, setLineupLoading] = useState(false)
    // A picked day whose lineup failed to load shows a retry, never the day before.
    const [lineupError, setLineupError] = useState(false)
    const [emptyConfirmed, setEmptyConfirmed] = useState(false)
    const confirmedEmptyKeyRef = useRef<string | null>(null)
    const pendingNullKeyRef = useRef<string | null>(null)
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
        setMyLineupScope(lineupScope(cached?.matchup, cached?.selectedDate ?? todayET()))
        setOppLineupScope(lineupScope(cached?.matchup, cached?.selectedDate ?? todayET()))
        setSelectedDate(cached?.selectedDate ?? todayET())
        setMatchupLoading(!cached)
        setLineupLoading(false)
        setLineupError(false)
        setError(null)
        setEmptyConfirmed(false)
        confirmedEmptyKeyRef.current = null
        pendingNullKeyRef.current = null
        matchupRef.current = cached?.matchup ?? null
        setDataOwnerKey(resourceKey)
    }, [current?.id, leagueId, resourceKey, setSelectedDate])

    const ownsResource = dataOwnerKey === resourceKey
    exposedMatchupRef.current = ownsResource ? matchupRef.current : null

    const confirmEmpty = useCallback(() => {
        if (!resourceKey || !current || !leagueId || activeResourceKeyRef.current !== resourceKey) return
        if (!membershipValidatedRef.current) {
            if (membershipErrorRef.current) setError('Failed to load matchup')
            return
        }
        pendingNullKeyRef.current = null
        confirmedEmptyKeyRef.current = resourceKey
        setEmptyConfirmed(true)
        setError(null)
        setMatchup(null)
        matchupRef.current = null
        setWeekDays([])
        setLeagueMatchups([])
        setMyLineup(null)
        setOppLineup(null)
        setSelectedDate(todayET())
        writeMatchupCache(current.id, leagueId, {
            selectedDate: todayET(), matchup: null, weekDays: [], leagueMatchups: [],
            myLineup: null, oppLineup: null,
        })
    }, [current, leagueId, resourceKey, setSelectedDate])

    useEffect(() => {
        if (pendingNullKeyRef.current === resourceKey) confirmEmpty()
    }, [membershipValidated, membershipError, resourceKey, confirmEmpty])

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
            const stillCurrent = () => seq === lineupSeqRef.current &&
                activeResourceKeyRef.current === capturedResourceKey && date === selectedDateRef.current && matchupRef.current?.id === m.id
            try {
                const lineups = await fetchLineups(m, date, currentLeagueId)
                if (!stillCurrent()) return null
                setMyLineup(lineups.mine)
                setOppLineup(lineups.opp)
                setMyLineupScope(lineupScope(m, date))
                setOppLineupScope(lineupScope(m, date))
                setLineupError(false)
                return lineups
            } catch (e) {
                if (!stillCurrent()) return null
                console.error(e)
                setMyLineup(null)
                setOppLineup(null)
                setLineupError(true)
                return null
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
            setMyLineupScope(lineupScope(m, date))
        },
        [leagueId, ownsResource, resourceKey],
    )

    const refreshSilently = useCallback(
        async () => {
            const m = matchupRef.current
            const capturedResourceKey = resourceKey
            if (!capturedResourceKey || !ownsResource || !m || !leagueId) return false
            const seq = ++lineupSeqRef.current
            const currentLeagueId = leagueId
            const date = selectedDateRef.current
            try {
                const [mine, opp] = await Promise.all([
                    getWeeklyLineup(m.myMemberId, currentLeagueId, m.seasonId, m.weekNumber, date, { allowCachedStatics: true }),
                    getWeeklyLineup(m.opponentMemberId, currentLeagueId, m.seasonId, m.weekNumber, date, { allowCachedStatics: true }),
                ])
                if (seq !== lineupSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey ||
                    date !== selectedDateRef.current) return false
                setMyLineup((previous) => reuseLineup(previous, mine))
                setOppLineup((previous) => reuseLineup(previous, opp))
                setMyLineupScope(lineupScope(m, date))
                setOppLineupScope(lineupScope(m, date))
                setLineupError(false)
                return true
            } catch (error) {
                if (seq !== lineupSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey ||
                    date !== selectedDateRef.current) return false
                console.error(error)
                setLineupError(true)
                return false
            }
        },
        [leagueId, ownsResource, resourceKey],
    )

    const load = useCallback(async () => {
        const capturedResourceKey = resourceKey
        if (!capturedResourceKey || !current || !user || !leagueId || activeResourceKeyRef.current !== capturedResourceKey) return
        // Sequence concurrent loads (league switch / focus) so a slower fetch for
        // a previous league can never overwrite the current league's matchup.
        const seq = ++loadSeqRef.current
        lineupSeqRef.current += 1
        const hasVisibleMatchup = matchupRef.current != null
        setMatchupLoading(!hasVisibleMatchup && confirmedEmptyKeyRef.current !== capturedResourceKey)
        pendingNullKeyRef.current = null
        if (!hasVisibleMatchup) {
            setMyLineup(null)
            setOppLineup(null)
        }
        try {
            setError(null)
            const m = await getMyMatchup(current.id, leagueId)
            if (seq !== loadSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey) return
            if (m) {
                confirmedEmptyKeyRef.current = null
                setEmptyConfirmed(false)
                setMatchup(m)
                matchupRef.current = m
                const daysPromise = getWeekDays(m.weekNumber, m.seasonYear)
                const readSelection = async (boundaries: { date: string }[]) => {
                    while (seq === loadSeqRef.current && activeResourceKeyRef.current === capturedResourceKey) {
                        const requested = selectedDateRef.current
                        const selected = clampDateToWeek(requested, boundaries)
                        try {
                            return { requested, selected, lineups: await fetchLineups(m, selected, leagueId) }
                        } catch (error) {
                            if (requested === selectedDateRef.current) throw error
                        }
                    }
                    throw new Error('Matchup read superseded')
                }
                const lineupsPromise = getSeasonWeekDates(m.seasonYear, m.weekNumber).then(async (dates) => {
                    const boundaries = dates.length > 0 ? dates.map((date) => ({ date })) : await daysPromise
                    return { boundaries, ...await readSelection(boundaries) }
                })
                const [days, weekMatchups, initial] = await Promise.all([
                    daysPromise,
                    getLeagueWeekMatchups(leagueId, m.seasonId, m.weekNumber, m.myMemberId),
                    lineupsPromise,
                ])
                if (seq !== loadSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey) return
                let selection = initial
                while (selection.requested !== selectedDateRef.current) {
                    selection = { ...initial, ...await readSelection(initial.boundaries) }
                    if (seq !== loadSeqRef.current || activeResourceKeyRef.current !== capturedResourceKey) return
                }
                const { selected, lineups } = selection
                lineupSeqRef.current += 1
                setWeekDays(days)
                setLeagueMatchups(weekMatchups)
                setSelectedDate(selected)
                setMyLineup(lineups.mine)
                setOppLineup(lineups.opp)
                setMyLineupScope(lineupScope(m, selected))
                setOppLineupScope(lineupScope(m, selected))
                setLineupLoading(false)
                setLineupError(false)
                writeMatchupCache(current.id, leagueId, {
                    selectedDate: selected,
                    matchup: m,
                    weekDays: days,
                    leagueMatchups: weekMatchups,
                    myLineup: lineups.mine,
                    oppLineup: lineups.opp,
                })
            } else {
                pendingNullKeyRef.current = capturedResourceKey
                confirmEmpty()
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
    }, [current, user, leagueId, fetchLineups, resourceKey, setSelectedDate, confirmEmpty])

    const refresh = useCallback(async () => {
        if (membershipErrorRef.current) await refreshMembershipsRef.current?.()
        await load()
    }, [load])

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
        let disposed = false
        const eventTimes = new Map<string, number>()
        const isActive = () => !disposed && activeResourceKeyRef.current === resourceKey
            && matchupRef.current?.id === matchup.id
        const refreshVisibleLineups = deferLeagueRefresh(() => isActive() ? refreshSilently() : undefined)
        const visibleMemberIds = new Set([matchup.myMemberId, matchup.opponentMemberId])
        const channel = subscribeToTableChanges(
            `league-matchups:${matchup.seasonId}:${matchup.weekNumber}`,
            {
                mode: 'per-watch',
                onReconnect: async () => {
                    if (!isActive()) return
                    if (leagueId) {
                        invalidateSeasonCache(leagueId)
                        for (const memberId of visibleMemberIds) invalidateCachedRoster(memberId, leagueId, matchup.seasonId)
                    }
                    invalidateWeekNumberCache()
                    await load()
                },
                watches: [{
                    event: 'UPDATE',
                    table: 'matchups',
                    filter: `league_season_id=eq.${matchup.seasonId}`,
                    onChange: (payload) => {
                        if (!isActive() || !isMatchupRealtimeRow(payload.new)) return
                        const row = payload.new
                        const { home_points, away_points, is_finalized, winner_member_id } = row
                        if (row.week_number !== (matchup.roundStartWeek ?? matchup.weekNumber)) return
                        // Order by the server commit time, not the score: corrections can reduce points.
                        const eventTime = Date.parse(payload.commit_timestamp)
                        if (Number.isFinite(eventTime)) {
                            if (eventTime < (eventTimes.get(row.id) ?? -Infinity)) return
                            eventTimes.set(row.id, eventTime)
                        }
                        if (row.id === matchup.id) {
                            setMatchup((prev) => {
                                if (!isActive() || !prev || prev.id !== row.id) return prev
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
                            !isActive() ? prev : prev.map((item) =>
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
                }],
            },
        )

        const stopChanges = leagueId ? listenForLeagueChanges(leagueId, change => {
            if (!isActive() || !['lineup', 'roster', 'catchup'].includes(change.topic)) return
            if (!leagueChangeAffects(change, { seasonId: matchup.seasonId, memberIds: [...visibleMemberIds], date: selectedDateRef.current })) return
            for (const memberId of visibleMemberIds) invalidateCachedRoster(memberId, leagueId, matchup.seasonId)
            refreshVisibleLineups.trigger()
        }) : undefined

        return () => {
            disposed = true
            stopChanges?.()
            reportRealtimeCleanup(
                'matchup',
                disposeTableChangeSubscription(channel, [refreshVisibleLineups]),
            )
        }
    }, [matchup?.id, matchup?.seasonId, matchup?.weekNumber, matchup?.myMemberId, matchup?.opponentMemberId, matchup?.roundStartWeek, ownsResource, refreshSilently, resourceKey, leagueId, load])

    const setVisibleSelectedDate = useCallback((date: string) => {
        if (ownsResource && activeResourceKeyRef.current === resourceKey) setSelectedDate(date)
    }, [ownsResource, resourceKey, setSelectedDate])

    return {
        emptyConfirmed: ownsResource && membershipValidated && emptyConfirmed,
        matchup: ownsResource ? matchup : undefined,
        leagueMatchups: ownsResource ? leagueMatchups : [],
        weekDays: ownsResource ? weekDays : [],
        selectedDate: ownsResource ? selectedDate : todayET(),
        setSelectedDate: setVisibleSelectedDate,
        myLineup: ownsResource && myLineupScope === lineupScope(matchup, selectedDate) ? myLineup : null,
        setMyLineup,
        oppLineup: ownsResource && oppLineupScope === lineupScope(matchup, selectedDate) ? oppLineup : null,
        matchupLoading: ownsResource ? matchupLoading : true,
        lineupLoading: ownsResource ? lineupLoading : false,
        lineupError: ownsResource ? lineupError : false,
        error: ownsResource ? error : null,
        refresh,
        loadMyLineup,
        loadLineups,
        refreshSilently,
        matchupRef: exposedMatchupRef,
    }
}
