import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FlashListRef } from '@shopify/flash-list'
import { Dimensions, type View } from 'react-native'
import { searchPlayers, PlayerRow } from '@/lib/players'
import { OwnedEntry } from '@/lib/roster'
import { getWeekDays, WeekDay, getStartedTeams } from '@/lib/lineup'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'
import {
    PLAYER_SEARCH_SORT_OPTIONS,
    sortPlayerSearchResults,
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
    rookiesOnly: boolean
}

export const SORT_OPTIONS = PLAYER_SEARCH_SORT_OPTIONS

const PAGE_SIZE = 60
const DEFAULT_SEARCH_PARAMS: SearchParams = {
    query: '',
    position: 'ALL',
    selectedTeams: [],
    leagueId: null,
    playingTeams: null,
    rookiesOnly: false,
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

function useTeamPicker() {
    const [selectedTeams, setSelectedTeams] = useState<string[]>([])
    const [popover, setPopover] = useState<{ top: number; right: number } | null>(null)
    const buttonRef = useRef<View>(null)

    const toggleTeam = useCallback((team: string) => {
        setSelectedTeams((prev) =>
            prev.includes(team) ? prev.filter((value) => value !== team) : [...prev, team],
        )
    }, [])

    const open = useCallback(() => {
        buttonRef.current?.measure((_x, _y, _width, _height, pageX, pageY) => {
            const screenWidth = Dimensions.get('window').width
            setPopover({ top: pageY, right: screenWidth - pageX })
        })
    }, [])

    return { selectedTeams, setSelectedTeams, toggleTeam, popover, setPopover, buttonRef, open }
}

function selectedPlayingTeams(selectedDays: string[], weekDays: WeekDay[]): string[] | null {
    if (selectedDays.length === 0) return null
    const sets = selectedDays.map((date) => {
        const day = weekDays.find((candidate) => candidate.date === date)
        return new Set(day?.playingTeams ?? [])
    })
    const [first, ...rest] = sets
    if (!first) return []
    const intersection = new Set(first)
    for (const set of rest) {
        for (const team of intersection) {
            if (!set.has(team)) intersection.delete(team)
        }
    }
    return Array.from(intersection)
}

export function usePlayerSearch(
    leagueId: string | null,
    ownedMap: Map<string, OwnedEntry>,
) {
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [selectedDays, setSelectedDays] = useState<string[]>([])
    const [sortMode, setSortMode] = useState<SortMode>('fpts')
    const [sortDir, setSortDir] = useState<SortDir>('desc')
    const [availableOnly, setAvailableOnly] = useState(true)
    const [rookiesOnly, setRookiesOnly] = useState(false)
    const [players, setPlayers] = useState<PlayerRow[]>([])
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const searchParamsRef = useRef<SearchParams>(DEFAULT_SEARCH_PARAMS)
    const offsetRef = useRef(0)
    const listRef = useRef<FlashListRef<PlayerRow>>(null)
    const isFirstLeagueRunRef = useRef(true)

    const teamPicker = useTeamPicker()
    const { selectedTeams, setSelectedTeams } = teamPicker
    const availability = useWeeklyAvailability()
    const playingTeams = useMemo(
        () => selectedPlayingTeams(selectedDays, availability.weekDays),
        [selectedDays, availability.weekDays],
    )

    const displayedPlayers = useMemo(() => {
        const filtered = availableOnly ? players.filter((player) => !ownedMap.has(player.id)) : players
        return sortPlayerSearchResults(filtered, sortMode, sortDir, availability.gamesLeft)
    }, [players, availableOnly, ownedMap, sortMode, sortDir, availability.gamesLeft])

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
            rookiesOnly,
        }
        const timer = setTimeout(() => load(params), 300)
        return () => clearTimeout(timer)
    }, [query, position, selectedTeams, leagueId, playingTeams, rookiesOnly, load])

    const toggleDay = useCallback((date: string) => {
        setSelectedDays((prev) =>
            prev.includes(date) ? prev.filter((value) => value !== date) : [...prev, date],
        )
    }, [])

    const clearAllFilters = useCallback(() => {
        setQuery('')
        setPosition('ALL')
        setSelectedTeams([])
        setSelectedDays([])
        setAvailableOnly(true)
        setRookiesOnly(false)
        setSortMode('fpts')
        setSortDir('desc')
    }, [setSelectedTeams])

    const activeFilterCount = useMemo(() => {
        let count = 0
        if (query.trim()) count++
        if (position !== 'ALL') count++
        if (selectedTeams.length > 0) count++
        if (selectedDays.length > 0) count++
        if (!availableOnly) count++
        if (rookiesOnly) count++
        if (sortMode !== 'fpts') count++
        return count
    }, [query, position, selectedTeams.length, selectedDays.length, availableOnly, rookiesOnly, sortMode])

    return {
        search: { query, setQuery },
        position: { value: position, setValue: setPosition },
        teamPicker,
        availability: {
            weekDays: availability.weekDays,
            selectedDays,
            setSelectedDays,
            toggleDay,
            gamesLeft: availability.gamesLeft,
        },
        sort: { mode: sortMode, setMode: setSortMode, dir: sortDir, setDir: setSortDir },
        toggles: { availableOnly, setAvailableOnly, rookiesOnly, setRookiesOnly },
        results: { players: displayedPlayers, loading, loadingMore, listRef, loadMore },
        activeFilterCount,
        clearAllFilters,
    }
}
