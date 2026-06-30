import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FlashListRef } from '@shopify/flash-list'
import { searchPlayers, PlayerRow } from '@/lib/players'
import { OwnedEntry } from '@/lib/roster'
import { getWeekDays, WeekDay, getStartedTeams } from '@/lib/lineup'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'
import {
    PLAYER_SEARCH_SORT_OPTIONS,
    type PlayerSearchSortDir,
    type PlayerSearchSortMode,
} from '@/lib/player-search-sort'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import {
    activePlayerFilterCount,
    availabilityPlayerScope,
    DEFAULT_PLAYER_SEARCH_PARAMS,
    PLAYER_SEARCH_PAGE_SIZE,
    playerSearchParamsKey,
    type PlayerAvailabilityFilter,
    type PlayerPlayingFilter,
    type PlayerSearchHealthFilter,
    type PlayerSearchParams,
} from '@/lib/player-search-state'

export type SortMode = PlayerSearchSortMode
type SortDir = PlayerSearchSortDir

export const SORT_OPTIONS = PLAYER_SEARCH_SORT_OPTIONS
export type HealthFilter = PlayerSearchHealthFilter
export type AvailabilityFilter = PlayerAvailabilityFilter
export type PlayingFilter = PlayerPlayingFilter

type CachedPage = {
    players: PlayerRow[]
    hasMore: boolean
    offset: number
}
const ROOKIE_SEARCH_MAX_PAGES = 20

function useWeeklyAvailability() {
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [startedTeams, setStartedTeams] = useState<Set<string>>(new Set())

    useEffect(() => {
        let cancelled = false
        const seasonYear = currentSeasonYear()
        const today = todayET()
        getCurrentWeekNumber(seasonYear).then((weekNum) => {
            if (cancelled) return
            return getWeekDays(weekNum ?? 1, seasonYear)
        }).then((days) => {
            if (!cancelled && days) setWeekDays(days)
        }).catch(console.error)
        getStartedTeams(today).then((teams) => {
            if (!cancelled) setStartedTeams(teams)
        }).catch(console.error)
        return () => { cancelled = true }
    }, [])

    const gamesLeft = useMemo(() => {
        const today = todayET()
        const map = new Map<string, number>()
        for (const day of weekDays) {
            if (day.date < today) continue
            for (const team of day.playingTeams) {
                if (day.date === today && startedTeams.has(team)) continue
                map.set(team, (map.get(team) ?? 0) + 1)
            }
        }
        return map
    }, [weekDays, startedTeams])

    return { weekDays, gamesLeft }
}

export function usePlayerSearch(
    leagueId: string | null,
    ownedMap: Map<string, OwnedEntry>,
    waiverIds: Set<string>,
    currentMemberId?: string,
) {
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [selectedTeams, setSelectedTeams] = useState<string[]>([])
    const [playingFilter, setPlayingFilter] = useState<PlayingFilter>('all')
    const [sortMode, setSortMode] = useState<SortMode>('fpts')
    const [sortDir, setSortDir] = useState<SortDir>('desc')
    const [health, setHealth] = useState<HealthFilter>('all')
    const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>('free_agents')
    const [rookiesOnly, setRookiesOnly] = useState(false)
    const [players, setPlayers] = useState<PlayerRow[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const searchParamsRef = useRef<PlayerSearchParams>(DEFAULT_PLAYER_SEARCH_PARAMS)
    const offsetRef = useRef(0)
    const listRef = useRef<FlashListRef<PlayerRow>>(null)
    const isFirstLeagueRunRef = useRef(true)
    const currentKeyRef = useRef(playerSearchParamsKey(DEFAULT_PLAYER_SEARCH_PARAMS))
    const requestSeqRef = useRef(0)
    const loadMoreSeqRef = useRef(0)
    const playersRef = useRef<PlayerRow[]>([])
    const pageCacheRef = useRef(new Map<string, CachedPage>())
    const debouncedQuery = useDebouncedValue(query, 300)

    const weeklyAvailability = useWeeklyAvailability()
    const todayTeams = useMemo(() => {
        const today = todayET()
        const todayRow = weeklyAvailability.weekDays.find((day) => day.date === today)
        return new Set(todayRow?.playingTeams ?? [])
    }, [weeklyAvailability.weekDays])
    const todayTeamList = useMemo(() => Array.from(todayTeams), [todayTeams])
    const playingTeams = useMemo(
        () => playingFilter === 'today' ? todayTeamList : null,
        [playingFilter, todayTeamList],
    )
    const excludedTeams = useMemo(
        () => playingFilter === 'not_today' ? todayTeamList : [],
        [playingFilter, todayTeamList],
    )
    const scopedPlayerIds = useMemo(
        () => availabilityPlayerScope(availabilityFilter, ownedMap, waiverIds, currentMemberId),
        [availabilityFilter, ownedMap, waiverIds, currentMemberId],
    )

    const searchParams = useMemo<PlayerSearchParams>(() => ({
        query: debouncedQuery,
        position,
        selectedTeams,
        leagueId,
        playingTeams,
        excludedTeams,
        includePlayerIds: scopedPlayerIds.includePlayerIds,
        excludePlayerIds: scopedPlayerIds.excludePlayerIds,
        rookiesOnly,
        health,
        sortBy: sortMode,
        sortDir,
    }), [
        debouncedQuery,
        position,
        selectedTeams,
        leagueId,
        playingTeams,
        excludedTeams,
        scopedPlayerIds,
        rookiesOnly,
        health,
        sortMode,
        sortDir,
    ])
    const searchParamsKey = useMemo(() => playerSearchParamsKey(searchParams), [searchParams])

    const fetchPage = useCallback((params: PlayerSearchParams, offset: number) =>
        searchPlayers(
            params.query,
            params.position,
            params.selectedTeams,
            params.leagueId,
            params.playingTeams,
            params.rookiesOnly,
            offset,
            params.health,
            {
                includePlayerIds: params.includePlayerIds,
                excludePlayerIds: params.excludePlayerIds,
                excludedTeams: params.excludedTeams,
            },
            params.sortBy,
            params.sortDir,
        ), [])

    const fetchCompleteResults = useCallback(async (params: PlayerSearchParams) => {
        const firstPage = await fetchPage(params, 0)
        if (!params.rookiesOnly || firstPage.length < PLAYER_SEARCH_PAGE_SIZE) return firstPage

        const players = [...firstPage]
        let nextOffset = PLAYER_SEARCH_PAGE_SIZE
        for (let page = 1; page < ROOKIE_SEARCH_MAX_PAGES; page += 1) {
            const nextPage = await fetchPage(params, nextOffset)
            if (nextPage.length === 0) break
            players.push(...nextPage)
            if (nextPage.length < PLAYER_SEARCH_PAGE_SIZE) break
            nextOffset += PLAYER_SEARCH_PAGE_SIZE
        }
        return players
    }, [fetchPage])

    useEffect(() => {
        playersRef.current = players
    }, [players])

    useEffect(() => {
        searchParamsRef.current = searchParams
        currentKeyRef.current = searchParamsKey
        offsetRef.current = 0
        setLoadingMore(false)
        setHasMore(false)
        listRef.current?.scrollToOffset({ offset: 0, animated: false })

        const cached = pageCacheRef.current.get(searchParamsKey)
        if (cached) {
            setPlayers(cached.players)
            playersRef.current = cached.players
            setHasMore(cached.hasMore)
            offsetRef.current = cached.offset
            setLoading(false)
            setRefreshing(false)
            return
        }

        const requestId = ++requestSeqRef.current
        setRefreshing(true)
        setLoading(playersRef.current.length === 0)

        fetchCompleteResults(searchParams)
            .then((results) => {
                if (requestSeqRef.current !== requestId || currentKeyRef.current !== searchParamsKey) return
                const hasNext = !searchParams.rookiesOnly && results.length === PLAYER_SEARCH_PAGE_SIZE
                pageCacheRef.current.set(searchParamsKey, { players: results, hasMore: hasNext, offset: 0 })
                playersRef.current = results
                setPlayers(results)
                setHasMore(hasNext)
            })
            .catch(console.error)
            .finally(() => {
                if (requestSeqRef.current !== requestId || currentKeyRef.current !== searchParamsKey) return
                setLoading(false)
                setRefreshing(false)
            })
    }, [searchParams, searchParamsKey, fetchCompleteResults])

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore) return
        const params = searchParamsRef.current
        const paramsKey = currentKeyRef.current
        const nextOffset = offsetRef.current + PLAYER_SEARCH_PAGE_SIZE
        const requestId = ++loadMoreSeqRef.current
        setLoadingMore(true)
        try {
            const results = await fetchPage(params, nextOffset)
            if (loadMoreSeqRef.current !== requestId || currentKeyRef.current !== paramsKey) return
            if (results.length > 0) {
                offsetRef.current = nextOffset
                setPlayers((prev) => {
                    const merged = [...prev, ...results]
                    playersRef.current = merged
                    pageCacheRef.current.set(paramsKey, {
                        players: merged,
                        hasMore: results.length === PLAYER_SEARCH_PAGE_SIZE,
                        offset: nextOffset,
                    })
                    return merged
                })
            }
            setHasMore(results.length === PLAYER_SEARCH_PAGE_SIZE)
        } catch (e) {
            console.error(e)
        } finally {
            if (loadMoreSeqRef.current === requestId && currentKeyRef.current === paramsKey) {
                setLoadingMore(false)
            }
        }
    }, [loadingMore, hasMore, fetchPage])

    useEffect(() => {
        if (isFirstLeagueRunRef.current) {
            isFirstLeagueRunRef.current = false
            return
        }
        setPlayers([])
        playersRef.current = []
        setLoading(true)
        setRefreshing(false)
    }, [leagueId])

    const clearAllFilters = useCallback(() => {
        setQuery('')
        setPosition('ALL')
        setSelectedTeams([])
        setPlayingFilter('all')
        setAvailabilityFilter('free_agents')
        setRookiesOnly(false)
        setHealth('all')
        setSortMode('fpts')
        setSortDir('desc')
    }, [setSelectedTeams])

    const activeFilterCount = useMemo(
        () => activePlayerFilterCount({
            query,
            position,
            selectedTeams,
            playingFilter,
            availabilityFilter,
            rookiesOnly,
            health,
            sortMode,
        }),
        [query, position, selectedTeams, playingFilter, availabilityFilter, rookiesOnly, health, sortMode],
    )

    return {
        search: { query, setQuery },
        position: { value: position, setValue: setPosition },
        teamPicker: { selectedTeams, setSelectedTeams },
        availability: {
            weekDays: weeklyAvailability.weekDays,
            gamesLeft: weeklyAvailability.gamesLeft,
        },
        playing: { value: playingFilter, setValue: setPlayingFilter },
        sort: { mode: sortMode, setMode: setSortMode, dir: sortDir, setDir: setSortDir },
        health: { value: health, setValue: setHealth },
        availabilityFilter: { value: availabilityFilter, setValue: setAvailabilityFilter },
        toggles: { rookiesOnly, setRookiesOnly },
        results: { players, loading, refreshing, loadingMore, listRef, loadMore },
        activeFilterCount,
        clearAllFilters,
    }
}
