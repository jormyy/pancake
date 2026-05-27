import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FlashListRef } from '@shopify/flash-list'
import { Dimensions } from 'react-native'
import { searchPlayers, PlayerRow } from '@/lib/players'
import { OwnedEntry } from '@/lib/roster'
import { getWeekDays, WeekDay, getStartedTeams } from '@/lib/lineup'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayET } from '@/lib/shared/dates'

export type SortMode = 'fpts' | 'gamesLeft' | 'name' | 'team' | 'yearsExp'

export const SORT_OPTIONS: { key: SortMode; label: string }[] = [
    { key: 'fpts', label: 'FPts' },
    { key: 'gamesLeft', label: 'G Left' },
    { key: 'name', label: 'Name' },
    { key: 'team', label: 'Team' },
    { key: 'yearsExp', label: 'Exp' },
]

const PAGE_SIZE = 60

export function usePlayerSearch(
    leagueId: string | null,
    ownedMap: Map<string, OwnedEntry>,
) {
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [selectedTeams, setSelectedTeams] = useState<string[]>([])
    const [teamPopover, setTeamPopover] = useState<{ top: number; right: number } | null>(null)
    const teamBtnRef = useRef<any>(null)
    const [selectedDays, setSelectedDays] = useState<string[]>([])
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [startedTeams, setStartedTeams] = useState<Set<string>>(new Set())
    const [sortMode, setSortMode] = useState<SortMode>('fpts')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
    const [availableOnly, setAvailableOnly] = useState(true)
    const [rookiesOnly, setRookiesOnly] = useState(false)
    const [players, setPlayers] = useState<PlayerRow[]>([])
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const searchParamsRef = useRef({ query: '', position: 'ALL', selectedTeams: [] as string[], leagueId: null as string | null, playingTeams: null as string[] | null, rookiesOnly: false })
    const offsetRef = useRef(0)
    const listRef = useRef<FlashListRef<PlayerRow>>(null)

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

    const displayedPlayers = useMemo(() => {
        const list = availableOnly ? players.filter((p) => !ownedMap.has(p.id)) : players
        const sorted = [...list].sort((a, b) => {
            let cmp = 0
            switch (sortMode) {
                case 'fpts':
                    break
                case 'gamesLeft': {
                    const ga = gamesLeft.get(a.nba_team ?? '') ?? 0
                    const gb = gamesLeft.get(b.nba_team ?? '') ?? 0
                    cmp = gb - ga
                    break
                }
                case 'name':
                    cmp = (a.display_name ?? '').localeCompare(b.display_name ?? '')
                    break
                case 'team':
                    cmp = (a.nba_team ?? '').localeCompare(b.nba_team ?? '')
                    break
                case 'yearsExp':
                    cmp = (a.years_exp ?? 99) - (b.years_exp ?? 99)
                    break
            }
            return sortDir === 'asc' ? cmp : -cmp
        })
        return sorted
    }, [players, availableOnly, ownedMap, sortMode, sortDir, gamesLeft])

    const playingTeams = useMemo<string[] | null>(() => {
        if (selectedDays.length === 0) return null
        const sets = selectedDays.map((date) => {
            const day = weekDays.find((d) => d.date === date)
            return new Set(day?.playingTeams ?? [])
        })
        const [first, ...rest] = sets
        if (!first) return []
        const intersection = new Set(first)
        for (const s of rest) {
            for (const team of intersection) {
                if (!s.has(team)) intersection.delete(team)
            }
        }
        return Array.from(intersection)
    }, [selectedDays, weekDays])

    useEffect(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: false })
    }, [sortMode, sortDir])

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

    const load = useCallback(async (q: string, pos: string, teams: string[], lgId: string | null, playing: string[] | null, rookies: boolean) => {
        searchParamsRef.current = { query: q, position: pos, selectedTeams: teams, leagueId: lgId, playingTeams: playing, rookiesOnly: rookies }
        offsetRef.current = 0
        setLoading(true)
        setHasMore(false)
        try {
            const results = await searchPlayers(q, pos, teams, lgId, playing, rookies, 0)
            setPlayers(results)
            setHasMore(!rookies && results.length === PAGE_SIZE)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [])

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore) return
        const p = searchParamsRef.current
        const nextOffset = offsetRef.current + PAGE_SIZE
        setLoadingMore(true)
        try {
            const results = await searchPlayers(p.query, p.position, p.selectedTeams, p.leagueId, p.playingTeams, p.rookiesOnly, nextOffset)
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

    const isFirstLeagueRunRef = useRef(true)
    useEffect(() => {
        if (isFirstLeagueRunRef.current) {
            isFirstLeagueRunRef.current = false
            return
        }
        setPlayers([])
        setLoading(true)
    }, [leagueId])

    useEffect(() => {
        const timer = setTimeout(() => load(query, position, selectedTeams, leagueId, playingTeams, rookiesOnly), 300)
        return () => clearTimeout(timer)
    }, [query, position, selectedTeams, leagueId, playingTeams, rookiesOnly, load])

    function toggleTeam(t: string) {
        setSelectedTeams((prev) =>
            prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
        )
    }

    function toggleDay(date: string) {
        setSelectedDays((prev) =>
            prev.includes(date) ? prev.filter((x) => x !== date) : [...prev, date]
        )
    }

    function clearAllFilters() {
        setQuery('')
        setPosition('ALL')
        setSelectedTeams([])
        setSelectedDays([])
        setAvailableOnly(true)
        setRookiesOnly(false)
        setSortMode('fpts')
        setSortDir('desc')
    }

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
    }, [query, position, selectedTeams, selectedDays, availableOnly, rookiesOnly, sortMode])

    function openTeamPicker() {
        teamBtnRef.current?.measure((_x: number, _y: number, _width: number, _height: number, pageX: number, pageY: number) => {
            const screenWidth = Dimensions.get('window').width
            setTeamPopover({ top: pageY, right: screenWidth - pageX })
        })
    }

    return {
        query, setQuery,
        position, setPosition,
        selectedTeams, setSelectedTeams,
        teamPopover, setTeamPopover,
        teamBtnRef,
        selectedDays, setSelectedDays,
        weekDays,
        sortMode, setSortMode,
        sortDir, setSortDir,
        availableOnly, setAvailableOnly,
        rookiesOnly, setRookiesOnly,
        loading, loadingMore,
        gamesLeft,
        displayedPlayers,
        activeFilterCount,
        listRef,
        toggleTeam,
        toggleDay,
        clearAllFilters,
        openTeamPicker,
        loadMore,
    }
}
