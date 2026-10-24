import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FlashListRef } from '@shopify/flash-list'
import { searchPlayers, PlayerRow } from '@/lib/players'
import { OwnedEntry } from '@/lib/roster'
import { getWeekDays, WeekDay } from '@/lib/lineup'
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
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { AppState, type AppStateStatus } from 'react-native'
import { leagueSnapshotRevision } from '@/lib/league-changes'
import { usePanelActivity } from '@/contexts/panel-activity'

export const SORT_OPTIONS = PLAYER_SEARCH_SORT_OPTIONS

type CachedPage = {
    players: PlayerRow[]
    hasMore: boolean
    offset: number
    savedAt?: number
}
const PLAYER_SEARCH_CACHE_PREFIX = 'pancake:player-search:v2:'
const ROOKIE_SEARCH_MAX_PAGES = 20
const MAX_MEMORY_PAGES = 12
const EMPTY_TEAMS: string[] = []

const playerSearchCacheKey = (key: string) => `${PLAYER_SEARCH_CACHE_PREFIX}${key}`

export function useWeeklyAvailability(enabled: boolean, active = true) {
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])

    useEffect(() => {
        if (!enabled) {
            setWeekDays([])
            return
        }
        if (!active) return
        let cancelled = false
        let appState: AppStateStatus = AppState.currentState
        let loadedDate: string | null = null
        let requestSequence = 0
        const load = async (includeSchedule: boolean) => {
            if ((typeof navigator !== 'undefined' && navigator.onLine === false)
                || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
            const requestId = ++requestSequence
            const seasonYear = currentSeasonYear()
            const today = todayET()
            try {
                const days = includeSchedule || loadedDate !== today
                    ? await getCurrentWeekNumber(seasonYear).then((weekNum) => getWeekDays(weekNum ?? 1, seasonYear))
                    : null
                if (cancelled || requestSequence !== requestId) return
                loadedDate = today
                if (days) setWeekDays(days)
            } catch (error) {
                if (!cancelled && requestSequence === requestId) console.error(error)
            }
        }
        void load(true)
        const poll = setInterval(() => {
            if (appState === 'active') void load(false)
        }, 60_000)
        const subscription = AppState.addEventListener('change', (nextState) => {
            const becameActive = appState !== 'active' && nextState === 'active'
            appState = nextState
            if (becameActive) void load(true)
        })
        return () => {
            cancelled = true
            requestSequence += 1
            clearInterval(poll)
            subscription.remove()
        }
    }, [enabled, active])

    return { weekDays }
}

export function usePlayerSearch(
    leagueId: string | null,
    ownedMap: Map<string, OwnedEntry>,
    waiverIds: Set<string>,
    currentMemberId?: string,
    options: { enabled?: boolean; online?: boolean; focused?: boolean; ownerId?: string; admitted?: boolean } = {},
) {
    const enabled = options.enabled ?? true
    const admitted = options.admitted ?? true
    const online = options.online ?? true
    const panelActive = usePanelActivity()
    const focused = (options.focused ?? true) && panelActive
    const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
    useEffect(() => {
        if (typeof document === 'undefined') return
        const update = () => setVisible(document.visibilityState !== 'hidden')
        update()
        document.addEventListener('visibilitychange', update)
        return () => document.removeEventListener('visibilitychange', update)
    }, [])
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [selectedTeams, setSelectedTeams] = useState<string[]>([])
    const [playingFilter, setPlayingFilter] = useState<PlayerPlayingFilter>('all')
    const [sortMode, setSortMode] = useState<PlayerSearchSortMode>('fpts')
    const [sortDir, setSortDir] = useState<PlayerSearchSortDir>('desc')
    const [health, setHealth] = useState<PlayerSearchHealthFilter>('all')
    const [availabilityFilter, setAvailabilityFilter] = useState<PlayerAvailabilityFilter>('free_agents')
    const [rookiesOnly, setRookiesOnly] = useState(false)
    const [seasonYear, setSeasonYear] = useState<number | null>(null)
    const [players, setPlayers] = useState<PlayerRow[]>([])
    const [dataKey, setDataKey] = useState<string | null>(null)
    const [validatedKey, setValidatedKey] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const [hasMore, setHasMore] = useState(false)
    const [error, setError] = useState<Error | null>(null)
    const [retryToken, setRetryToken] = useState(0)
    const pendingSource = useRef<{ key: string; revision: string | null; requestId: number; activity: number; retry: number } | null>(null)
    const validatedSource = useRef<{ key: string; revision: string | null; activity: number; retry: number } | null>(null)
    const settledSource = useRef<{ key: string; revision: string | null; activity: number; retry: number; savedAt: number; valid: boolean } | null>(null)
    const activityEpoch = useRef(0)
    const lastActivity = useRef<boolean | null>(null)
    const retryRef = useRef(retryToken)
    retryRef.current = retryToken
    const searchParamsRef = useRef<PlayerSearchParams>(DEFAULT_PLAYER_SEARCH_PARAMS)
    const offsetRef = useRef(0)
    const listRef = useRef<FlashListRef<PlayerRow>>(null)
    const pendingScrollTopRef = useRef(false)
    const currentKeyRef = useRef(playerSearchParamsKey(DEFAULT_PLAYER_SEARCH_PARAMS))
    const requestSeqRef = useRef(0)
    const loadMoreSeqRef = useRef(0)
    const playersRef = useRef<PlayerRow[]>([])
    const pageCacheRef = useRef(new Map<string, CachedPage>())
    const debouncedQuery = useDebouncedValue(query, 300)

    const cachePage = useCallback((key: string, page: CachedPage) => {
        pageCacheRef.current.delete(key)
        pageCacheRef.current.set(key, page)
        while (pageCacheRef.current.size > MAX_MEMORY_PAGES) {
            const oldestKey = pageCacheRef.current.keys().next().value
            if (oldestKey == null) break
            pageCacheRef.current.delete(oldestKey)
        }
    }, [])

    const weeklyAvailability = useWeeklyAvailability(enabled, focused && online && visible)
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
        () => playingFilter === 'not_today' ? todayTeamList : EMPTY_TEAMS,
        [playingFilter, todayTeamList],
    )
    const scopedPlayerIds = useMemo(
        () => availabilityPlayerScope(availabilityFilter, ownedMap, waiverIds, currentMemberId),
        [availabilityFilter, ownedMap, waiverIds, currentMemberId],
    )

    const paramsCandidate = useMemo<PlayerSearchParams>(() => ({
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
        seasonYear,
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
        seasonYear,
    ])
    const searchParamsKey = JSON.stringify([todayET(), options.ownerId ?? null, currentMemberId ?? null, playerSearchParamsKey(paramsCandidate)])
    // Support refreshes can replace Maps without changing the actual search.
    // Only semantic query or identity changes start a different request.
    const stableParamsRef = useRef({ key: searchParamsKey, params: paramsCandidate })
    if (stableParamsRef.current.key !== searchParamsKey) {
        stableParamsRef.current = { key: searchParamsKey, params: paramsCandidate }
    }
    const searchParams = stableParamsRef.current.params
    const renderedKeyRef = useRef(searchParamsKey)
    renderedKeyRef.current = searchParamsKey
    const activeRef = useRef(false)
    const readActivity = enabled && online && focused && visible
    if (lastActivity.current !== readActivity) { lastActivity.current = readActivity; activityEpoch.current += 1 }
    activeRef.current = admitted && readActivity

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
            { sortMode: params.sortBy, sortDir: params.sortDir, seasonYear: params.seasonYear },
        ), [])

    const fetchCompleteResults = useCallback(async (params: PlayerSearchParams, canRead: () => boolean) => {
        const firstPage = await fetchPage(params, 0)
        if (!canRead()) throw new Error('Search read is no longer active')
        if (!params.rookiesOnly || firstPage.length < PLAYER_SEARCH_PAGE_SIZE) return firstPage

        // Fetch remaining pages in parallel batches instead of one-by-one —
        // the rookie pool spans a handful of pages and serial awaits made the
        // filter feel sluggish.
        const players = [...firstPage]
        const pageParams = { ...params, seasonYear: firstPage[0]?.stats_season_year ?? params.seasonYear }
        const BATCH_SIZE = 4
        let page = 1
        while (page < ROOKIE_SEARCH_MAX_PAGES) {
            if (!canRead()) throw new Error('Search read is no longer active')
            const batchPages = Math.min(BATCH_SIZE, ROOKIE_SEARCH_MAX_PAGES - page)
            const batch = await Promise.all(Array.from({ length: batchPages }, (_, i) =>
                fetchPage(pageParams, (page + i) * PLAYER_SEARCH_PAGE_SIZE)))
            if (!canRead()) throw new Error('Search read is no longer active')
            let done = false
            for (const nextPage of batch) {
                players.push(...nextPage)
                if (nextPage.length < PLAYER_SEARCH_PAGE_SIZE) { done = true; break }
            }
            if (done) break
            page += batchPages
        }
        return players
    }, [fetchPage])

    useEffect(() => {
        playersRef.current = players
    }, [players])

    // FlashList v2 anchors on the previously-visible row when the data array
    // changes, so a brand-new filter/sort/search result set lands scrolled
    // partway down (an immediate scrollToOffset gets undone once the async page
    // commits). Snap back to the top after the fresh result set renders — armed
    // only by a param change, so paging in more rows via loadMore never jumps.
    useEffect(() => {
        if (!pendingScrollTopRef.current) return
        pendingScrollTopRef.current = false
        const raf = requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset: 0, animated: false })
        })
        return () => cancelAnimationFrame(raf)
    }, [players])

    useEffect(() => {
        const requestId = ++requestSeqRef.current
        loadMoreSeqRef.current += 1
        const changedQuery = currentKeyRef.current !== searchParamsKey
        currentKeyRef.current = searchParamsKey
        searchParamsRef.current = searchParams
        setLoadingMore(false)
        setValidatedKey(null)
        const cancel = () => {
            if (pendingSource.current?.requestId === requestId) pendingSource.current = null
            requestSeqRef.current += 1
            loadMoreSeqRef.current += 1
        }
        if (!enabled) {
            validatedSource.current = null
            settledSource.current = null
            pageCacheRef.current.clear()
            playersRef.current = []
            setPlayers([])
            setDataKey(null)
            setHasMore(false)
            setLoading(false)
            setRefreshing(false)
            setError(null)
            return cancel
        }
        if (changedQuery) {
            setError(null)
            pendingScrollTopRef.current = true
            listRef.current?.scrollToOffset({ offset: 0, animated: false })
            const cached = pageCacheRef.current.get(searchParamsKey)
                ?? readPersistentCache<CachedPage>(playerSearchCacheKey(searchParamsKey))
            const rows = cached?.players ?? []
            playersRef.current = rows
            setPlayers(rows)
            setDataKey(searchParamsKey)
            setHasMore(cached?.hasMore ?? false)
            offsetRef.current = cached?.offset ?? 0
        }
        if (!admitted || !online || !focused || !visible) {
            setLoading(false)
            setRefreshing(false)
            return cancel
        }
        const revision = leagueId ? leagueSnapshotRevision(leagueId, 'daily') : null
        const prior = settledSource.current
        if (!changedQuery && prior?.key === searchParamsKey && prior.revision === revision
            && prior.activity === activityEpoch.current && prior.retry === retryToken && Date.now() - prior.savedAt < 300_000) {
            setValidatedKey(prior.valid ? searchParamsKey : null)
            setLoading(false)
            setRefreshing(false)
            return cancel
        }
        setRefreshing(true)
        setLoading(playersRef.current.length === 0)
        // Cache replay is useful content, never a successful revalidation.
        // A same-query failure stays visible through retries and support reads.
        const ownsRequest = () => requestSeqRef.current === requestId
            && renderedKeyRef.current === searchParamsKey && activeRef.current
        const source = { key: searchParamsKey, revision, requestId, activity: activityEpoch.current, retry: retryToken }
        validatedSource.current = null
        pendingSource.current = source
        fetchCompleteResults(searchParams, ownsRequest)
            .then((results) => {
                if (!ownsRequest()) return
                const hasNext = !searchParams.rookiesOnly && results.length === PLAYER_SEARCH_PAGE_SIZE
                const page = { players: results, hasMore: hasNext, offset: 0, savedAt: Date.now() }
                cachePage(searchParamsKey, page)
                writePersistentCache(playerSearchCacheKey(searchParamsKey), page)
                playersRef.current = results
                offsetRef.current = 0
                setDataKey(searchParamsKey)
                setPlayers(results)
                setHasMore(hasNext)
                setError(null)
                const unchangedSource = source.revision === (leagueId ? leagueSnapshotRevision(leagueId, 'daily') : null)
                validatedSource.current = unchangedSource ? source : null
                settledSource.current = { ...source, valid: unchangedSource, savedAt: Date.now() }
                setValidatedKey(unchangedSource ? searchParamsKey : null)
                if (!unchangedSource) setRetryToken(token => token + 1)
            })
            .catch((cause) => {
                if (!ownsRequest()) return
                settledSource.current = { ...source, valid: false, savedAt: Date.now() }
                const nextError = cause instanceof Error ? cause : new Error(String(cause))
                setError(nextError)
                console.error(nextError)
            })
            .finally(() => {
                if (pendingSource.current === source) pendingSource.current = null
                if (!ownsRequest()) return
                setLoading(false)
                setRefreshing(false)
            })
        return cancel
    }, [cachePage, enabled, admitted, online, focused, visible, retryToken, searchParams, searchParamsKey, fetchCompleteResults, leagueId])

    const loadMore = useCallback(async () => {
        if (!enabled || !admitted || !online || !focused || !visible || refreshing || loadingMore || !hasMore) return
        const params = searchParamsRef.current
        const paramsKey = currentKeyRef.current
        const nextOffset = offsetRef.current + PLAYER_SEARCH_PAGE_SIZE
        const requestId = ++loadMoreSeqRef.current
        setLoadingMore(true)
        try {
            const results = await fetchPage(params, nextOffset)
            if (loadMoreSeqRef.current !== requestId || renderedKeyRef.current !== paramsKey || !activeRef.current) return
            if (results.length > 0 && results[0].stats_season_year !== playersRef.current[0]?.stats_season_year) {
                setRetryToken(token => token + 1)
                return
            }
            if (results.length > 0) {
                offsetRef.current = nextOffset
                const merged = [...playersRef.current, ...results]
                playersRef.current = merged
                const page = {
                    players: merged,
                    hasMore: results.length === PLAYER_SEARCH_PAGE_SIZE,
                    offset: nextOffset,
                    savedAt: Date.now(),
                }
                cachePage(paramsKey, page)
                writePersistentCache(playerSearchCacheKey(paramsKey), page)
                setPlayers(merged)
            }
            setHasMore(results.length === PLAYER_SEARCH_PAGE_SIZE)
        } catch (e) {
            console.error(e)
        } finally {
            if (loadMoreSeqRef.current === requestId && currentKeyRef.current === paramsKey) {
                setLoadingMore(false)
            }
        }
    }, [cachePage, enabled, admitted, online, focused, visible, refreshing, loadingMore, hasMore, fetchPage])

    const isFallbackSeason = dataKey === searchParamsKey
        && players[0]?.stats_season_year === currentSeasonYear() - 1
    useEffect(() => {
        if (!enabled || !admitted || !online || !focused || !visible || seasonYear !== null || !isFallbackSeason) return
        const timer = setInterval(() => setRetryToken(token => token + 1), 60_000)
        return () => clearInterval(timer)
    }, [enabled, admitted, online, focused, visible, seasonYear, isFallbackSeason])

    const retry = useCallback(() => setRetryToken((token) => token + 1), [])
    const refreshIfChanged = useCallback(() => {
        const revision = leagueId ? leagueSnapshotRevision(leagueId, 'daily') : null
        const key = renderedKeyRef.current
        if (revision && [pendingSource.current, validatedSource.current].some(source => source?.key === key && source.revision === revision && source.activity === activityEpoch.current && source.retry === retryRef.current)) return
        setRetryToken(token => token + 1)
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
        setSeasonYear(null)
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
            seasonYear,
        }),
        [query, position, selectedTeams, playingFilter, availabilityFilter, rookiesOnly, health, sortMode, seasonYear],
    )

    const returningPage = enabled && dataKey !== searchParamsKey
        ? pageCacheRef.current.get(searchParamsKey) ?? readPersistentCache<CachedPage>(playerSearchCacheKey(searchParamsKey))
        : undefined

    return {
        search: { query, setQuery },
        position: { value: position, setValue: setPosition },
        teamPicker: { selectedTeams, setSelectedTeams },
        availability: {
            weekDays: weeklyAvailability.weekDays,
        },
        playing: { value: playingFilter, setValue: setPlayingFilter },
        sort: { mode: sortMode, setMode: setSortMode, dir: sortDir, setDir: setSortDir },
        health: { value: health, setValue: setHealth },
        availabilityFilter: { value: availabilityFilter, setValue: setAvailabilityFilter },
        toggles: { rookiesOnly, setRookiesOnly },
        season: { value: seasonYear, setValue: setSeasonYear },
        results: { players: enabled ? dataKey === searchParamsKey ? players : returningPage?.players ?? [] : [], loading: loading || Boolean(enabled && dataKey !== searchParamsKey && !returningPage), refreshing, loadingMore, error, listRef, loadMore, retry, refreshIfChanged, isSnapshot: !admitted || !online || validatedKey !== searchParamsKey || refreshing || Boolean(error) },
        activeFilterCount,
        clearAllFilters,
    }
}
