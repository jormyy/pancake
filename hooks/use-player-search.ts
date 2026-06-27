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

export type SortMode = PlayerSearchSortMode
type SortDir = PlayerSearchSortDir
type SearchParams = {
    query: string
    position: string
    selectedTeams: string[]
    leagueId: string | null
    playingTeams: string[] | null
    excludedTeams: string[]
    includePlayerIds?: string[]
    excludePlayerIds?: string[]
    rookiesOnly: boolean
    health: HealthFilter
    sortBy: SortMode
    sortDir: SortDir
}

export const SORT_OPTIONS = PLAYER_SEARCH_SORT_OPTIONS
export type HealthFilter = 'all' | 'healthy' | 'gtd' | 'out' | 'ir'
export type AvailabilityFilter = 'all' | 'free_agents' | 'waivers' | 'rostered' | 'mine'
export type PlayingFilter = 'all' | 'today' | 'not_today'

const PAGE_SIZE = 60
const DEFAULT_SEARCH_PARAMS: SearchParams = {
    query: '',
    position: 'ALL',
    selectedTeams: [],
    leagueId: null,
    playingTeams: null,
    excludedTeams: [],
    rookiesOnly: false,
    health: 'all',
    sortBy: 'fpts',
    sortDir: 'desc',
}

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
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const searchParamsRef = useRef<SearchParams>(DEFAULT_SEARCH_PARAMS)
    const offsetRef = useRef(0)
    const listRef = useRef<FlashListRef<PlayerRow>>(null)
    const isFirstLeagueRunRef = useRef(true)

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
    const availabilityPlayerScope = useMemo(() => {
        const ownedIds = Array.from(ownedMap.keys())
        const waiverIdList = Array.from(waiverIds)
        switch (availabilityFilter) {
            case 'free_agents':
                return { excludePlayerIds: Array.from(new Set([...ownedIds, ...waiverIdList])) }
            case 'waivers':
                return { includePlayerIds: waiverIdList }
            case 'rostered':
                return { includePlayerIds: ownedIds }
            case 'mine':
                return {
                    includePlayerIds: Array.from(ownedMap.entries())
                        .filter(([, entry]) => entry.memberId === currentMemberId)
                        .map(([playerId]) => playerId),
                }
            default:
                return {}
        }
    }, [availabilityFilter, ownedMap, waiverIds, currentMemberId])

    // Sorting is applied server-side across the whole filtered pool (see
    // searchPlayers), so the list renders the accumulated pages as-is. Changing
    // the sort re-queries from page 0 (via the load effect) and resets scroll.
    useEffect(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: false })
    }, [sortMode, sortDir])

    const load = useCallback(async (params: SearchParams) => {
        searchParamsRef.current = params
        offsetRef.current = 0
        setLoading(true)
        setHasMore(false)
        try {
            const results = await searchPlayers(
                params.query,
                params.position,
                params.selectedTeams,
                params.leagueId,
                params.playingTeams,
                params.rookiesOnly,
                0,
                params.health,
                {
                    includePlayerIds: params.includePlayerIds,
                    excludePlayerIds: params.excludePlayerIds,
                    excludedTeams: params.excludedTeams,
                },
                params.sortBy,
                params.sortDir,
            )
            setPlayers(results)
            setHasMore(!params.rookiesOnly && results.length === PAGE_SIZE)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [])

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore) return
        const params = searchParamsRef.current
        const nextOffset = offsetRef.current + PAGE_SIZE
        setLoadingMore(true)
        try {
            const results = await searchPlayers(
                params.query,
                params.position,
                params.selectedTeams,
                params.leagueId,
                params.playingTeams,
                params.rookiesOnly,
                nextOffset,
                params.health,
                {
                    includePlayerIds: params.includePlayerIds,
                    excludePlayerIds: params.excludePlayerIds,
                    excludedTeams: params.excludedTeams,
                },
                params.sortBy,
                params.sortDir,
            )
            if (results.length > 0) {
                offsetRef.current = nextOffset
                setPlayers((prev) => [...prev, ...results])
            }
            setHasMore(results.length === PAGE_SIZE)
        } catch (e) {
            console.error(e)
        } finally {
            setLoadingMore(false)
        }
    }, [loadingMore, hasMore])

    useEffect(() => {
        if (isFirstLeagueRunRef.current) {
            isFirstLeagueRunRef.current = false
            return
        }
        setPlayers([])
        setLoading(true)
    }, [leagueId])

    useEffect(() => {
        const params = {
            query,
            position,
            selectedTeams,
            leagueId,
            playingTeams,
            excludedTeams,
            includePlayerIds: availabilityPlayerScope.includePlayerIds,
            excludePlayerIds: availabilityPlayerScope.excludePlayerIds,
            rookiesOnly,
            health,
            sortBy: sortMode,
            sortDir,
        }
        const timer = setTimeout(() => load(params), 300)
        return () => clearTimeout(timer)
    }, [query, position, selectedTeams, leagueId, playingTeams, excludedTeams, availabilityPlayerScope, rookiesOnly, health, sortMode, sortDir, load])

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

    const activeFilterCount = useMemo(() => {
        let count = 0
        if (query.trim()) count++
        if (position !== 'ALL') count++
        if (selectedTeams.length > 0) count++
        if (playingFilter !== 'all') count++
        if (availabilityFilter !== 'free_agents') count++
        if (rookiesOnly) count++
        if (health !== 'all') count++
        if (sortMode !== 'fpts') count++
        return count
    }, [query, position, selectedTeams.length, playingFilter, availabilityFilter, rookiesOnly, health, sortMode])

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
        results: { players, loading, loadingMore, listRef, loadMore },
        activeFilterCount,
        clearAllFilters,
    }
}
