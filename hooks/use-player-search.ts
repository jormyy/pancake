import type { ScoringSettings } from '@pancake/core'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { readCachedLiveTeams } from '@/hooks/use-live-stats'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FlashListRef } from '@shopify/flash-list'
import { searchPlayers, getVisiblePlayerTotals, applyVisiblePlayerTotals, type VisiblePlayerTotals, PlayerRow } from '@/lib/players'
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
import { leagueSnapshotRevision, listenForLeagueChanges } from '@/lib/league-changes'
import { usePanelActivity } from '@/contexts/panel-activity'

export const SORT_OPTIONS = PLAYER_SEARCH_SORT_OPTIONS

type CachedPage = {
    players: PlayerRow[]
    hasMore: boolean
    offset: number
    savedAt?: number
}
type TimedPlayerTotals = { row: VisiblePlayerTotals | null; readAt: number }
type PlayerTotalsSnapshot = { key: string; rows: Map<string, TimedPlayerTotals> }
const PLAYER_SEARCH_CACHE_PREFIX = 'pancake:player-search:v2:'
const MAX_MEMORY_PAGES = 12
const EMPTY_TEAMS: string[] = []

const playerSearchCacheKey = (key: string) => `${PLAYER_SEARCH_CACHE_PREFIX}${key}`

function playerScoringSettings(value: unknown): ScoringSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const scoring: ScoringSettings = {}
    for (const [key, coefficient] of Object.entries(value)) {
        if (typeof coefficient === 'number' && Number.isFinite(coefficient)) scoring[key] = coefficient
    }
    return scoring
}

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
    options: { enabled?: boolean; online?: boolean; focused?: boolean; ownerId?: string; admitted?: boolean; initialLiveStats?: boolean; scoringSettings?: unknown } = {},
) {
    const enabled = options.enabled ?? true
    const initialLiveStats = options.initialLiveStats ?? false
    const scoring = useMemo(() => playerScoringSettings(options.scoringSettings), [options.scoringSettings])
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
    const totalsSnapshot = useRef<PlayerTotalsSnapshot | null>(null)
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
    const searchParamsKey = JSON.stringify([todayET(), options.ownerId ?? null, currentMemberId ?? null, playerSearchParamsKey(paramsCandidate), ...(initialLiveStats ? ['live-totals'] : [])])
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

    const fetchPage = useCallback(async (params: PlayerSearchParams, offset: number, canRead?: () => boolean) => {
        const players = await searchPlayers(
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
        )
        if (canRead && !canRead()) throw new Error('Search read is no longer active')
        if (!initialLiveStats || !params.leagueId || players.length === 0) return players
        const year = players[0]?.stats_season_year ?? params.seasonYear ?? currentSeasonYear()
        if (year !== currentSeasonYear()) return players
        const totals = await getVisiblePlayerTotals(params.leagueId, players.map(player => player.id), year)
        if (canRead && !canRead()) throw new Error('Search read is no longer active')
        const totalsByPlayer = new Map(totals.map(row => [row.player_id, row]))
        const key = JSON.stringify([JSON.stringify([options.ownerId, currentMemberId, params.leagueId]), params.leagueId, year])
        const rows = new Map(totalsSnapshot.current?.key === key ? totalsSnapshot.current.rows : [])
        const readAt = Date.now()
        for (const player of players) {
            rows.delete(player.id)
            rows.set(player.id, { row: totalsByPlayer.get(player.id) ?? null, readAt })
        }
        while (rows.size > 100) rows.delete(rows.keys().next().value!)
        totalsSnapshot.current = { key, rows }
        return players.map(player => {
            const row = totalsByPlayer.get(player.id)
            return row ? applyVisiblePlayerTotals(player, row, scoring) : player
        })
    }, [initialLiveStats, scoring, options.ownerId, currentMemberId])

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
        fetchPage(searchParams, 0, ownsRequest)
            .then((results) => {
                if (!ownsRequest()) return
                const hasNext = results.length === PLAYER_SEARCH_PAGE_SIZE
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
    }, [cachePage, enabled, admitted, online, focused, visible, retryToken, searchParams, searchParamsKey, fetchPage, leagueId])

    const loadMore = useCallback(async () => {
        if (!enabled || !admitted || !online || !focused || !visible || refreshing || loadingMore || !hasMore) return
        const params = searchParamsRef.current
        const paramsKey = currentKeyRef.current
        const nextOffset = offsetRef.current + PLAYER_SEARCH_PAGE_SIZE
        const requestId = ++loadMoreSeqRef.current
        setLoadingMore(true)
        try {
            const results = await fetchPage(params, nextOffset, () => loadMoreSeqRef.current === requestId && renderedKeyRef.current === paramsKey && activeRef.current)
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
        let disposed = false
        let running = false
        const requestId = requestSeqRef.current
        const ownsRequest = () => !disposed && requestSeqRef.current === requestId
            && renderedKeyRef.current === searchParamsKey && activeRef.current
        const probe = async () => {
            if (running || !ownsRequest()) return
            running = true
            try {
                const results = await fetchPage(searchParams, 0, ownsRequest)
                if (!ownsRequest() || !results.length || results[0].stats_season_year === playersRef.current[0]?.stats_season_year) return
                loadMoreSeqRef.current += 1
                const page = { players: results, hasMore: results.length === PLAYER_SEARCH_PAGE_SIZE, offset: 0, savedAt: Date.now() }
                cachePage(searchParamsKey, page)
                writePersistentCache(playerSearchCacheKey(searchParamsKey), page)
                playersRef.current = results
                offsetRef.current = 0
                setPlayers(results)
                setHasMore(page.hasMore)
                setLoadingMore(false)
            } catch (cause) {
                if (ownsRequest()) console.error(cause)
            } finally {
                running = false
            }
        }
        const timer = setInterval(() => { void probe() }, 60_000)
        return () => { disposed = true; clearInterval(timer) }
    }, [enabled, admitted, online, focused, visible, seasonYear, isFallbackSeason, searchParams, searchParamsKey, fetchPage, cachePage, retryToken])

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
        results: { players: enabled ? dataKey === searchParamsKey ? players : returningPage?.players ?? [] : [], totalsSnapshot: totalsSnapshot.current, loading: loading || Boolean(enabled && dataKey !== searchParamsKey && !returningPage), refreshing, loadingMore, error, listRef, loadMore, retry, refreshIfChanged, isSnapshot: !admitted || !online || validatedKey !== searchParamsKey || refreshing || Boolean(error) },
        activeFilterCount,
        clearAllFilters,
    }
}

export function useVisiblePlayerRows(players: PlayerRow[], leagueId: string | null, seasonYear: number | null, scoringSettings: unknown,
    options: { enabled: boolean; ownerKey: string; initialTotals?: PlayerTotalsSnapshot | null }) {
    const scoring = useMemo(() => playerScoringSettings(scoringSettings), [scoringSettings])
    const { active: browserActive, revision: activityRevision, isCurrent: isActivityCurrent } = useBrowserReadActivity()
    const [appActive, setAppActive] = useState(AppState.currentState === 'active')
    useEffect(() => {
        const listener = AppState.addEventListener('change', state => setAppActive(state === 'active'))
        return () => listener.remove()
    }, [])
    const [visibleIds, setVisibleIds] = useState<string[]>([])
    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: { item: PlayerRow; isViewable: boolean }[] }) => {
        const ids = viewableItems.filter(token => token.isViewable).map(token => token.item.id).slice(0, 50)
        setVisibleIds(previous => previous.join(',') === ids.join(',') ? previous : ids)
    }, [])
    const ids = visibleIds.filter(id => players.some(player => player.id === id)).join(',')
    const year = players[0]?.stats_season_year ?? seasonYear ?? currentSeasonYear()
    const liveSeason = year === currentSeasonYear()
    const key = JSON.stringify([options.ownerKey, leagueId, year])
    const [snapshot, setSnapshot] = useState<PlayerTotalsSnapshot>({ key, rows: new Map() })
    const initialTotals = options.initialTotals
    const mergedSnapshot = useMemo(() => {
        const rows = new Map(snapshot.key === key ? snapshot.rows : [])
        if (initialTotals?.key === key) {
            for (const [id, entry] of initialTotals.rows) {
                if ((rows.get(id)?.readAt ?? 0) <= entry.readAt) rows.set(id, entry)
            }
        }
        return rows
    }, [snapshot, initialTotals, key])
    const latestSnapshot = useRef(mergedSnapshot)
    latestSnapshot.current = mergedSnapshot
    const [now, setNow] = useState(Date.now)
    const active = options.enabled && browserActive && appActive && liveSeason
    const current = useRef({ key, ids, active })
    current.current = { key, ids, active }
    useEffect(() => {
        if (!active || !leagueId || !ids) return
        let disposed = false
        let running = false
        let pending = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const isCurrent = () => !disposed && current.current.active && current.current.key === key && current.current.ids === ids
            && isActivityCurrent(activityRevision)
        const playerIds = ids.split(',')
        const oldestRead = () => Math.min(...playerIds.map(id => latestSnapshot.current.get(id)?.readAt ?? 0))
        let lastRead = oldestRead()
        const schedule = () => {
            pending = true
            if (timer || running || !isCurrent()) return
            timer = setTimeout(() => { timer = null; void read() }, Math.max(300, lastRead + 10_000 - Date.now()))
        }
        const read = async () => {
            if (!isCurrent()) return
            running = true
            pending = false
            lastRead = Date.now()
            try {
                const rows = await getVisiblePlayerTotals(leagueId, playerIds, year)
                if (!isCurrent()) return
                const totalsByPlayer = new Map(rows.map(row => [row.player_id, row]))
                const readAt = Date.now()
                setSnapshot(previous => {
                    const merged = new Map(previous.key === key ? previous.rows : [])
                    for (const id of playerIds) {
                        merged.delete(id)
                        merged.set(id, { row: totalsByPlayer.get(id) ?? null, readAt })
                    }
                    while (merged.size > 100) merged.delete(merged.keys().next().value!)
                    return { key, rows: merged }
                })
                setNow(Date.now())
            } catch (error) {
                if (isCurrent()) console.error('Visible player stats could not refresh.', error)
            } finally {
                running = false
                if (pending) schedule()
            }
        }
        let registering = true
        const stop = listenForLeagueChanges(leagueId, change => {
            if (registering && change.topic === 'catchup') return
            if (['player_stats', 'game', 'catchup'].includes(change.topic)) schedule()
        })
        registering = false
        if (Date.now() - oldestRead() >= 10_000) schedule()
        return () => { disposed = true; stop(); if (timer) clearTimeout(timer) }
    }, [active, leagueId, ids, key, year, activityRevision, isActivityCurrent, initialTotals])
    useEffect(() => {
        if (!active) return
        const nextTipoff = [...mergedSnapshot.values()].map(entry => entry.row)
            .filter((row): row is VisiblePlayerTotals => row != null && row.game_status?.toLowerCase() === 'scheduled')
            .map(row => Date.parse(row.started_at ?? row.game_time ?? '')).filter(time => time > Date.now()).sort((a, b) => a - b)[0]
        if (nextTipoff == null) return
        const timer = setTimeout(() => setNow(Date.now()), Math.min(nextTipoff - Date.now() + 100, 2_147_483_647))
        return () => clearTimeout(timer)
    }, [active, mergedSnapshot, now])
    const rows = useMemo(() => {
        if (!liveSeason) return players
        const knownLiveTeams = leagueId ? readCachedLiveTeams(leagueId) : null
        return players.map(player => {
            const row = mergedSnapshot.get(player.id)?.row
            if (row) return applyVisiblePlayerTotals(player, row, scoring, now)
            return knownLiveTeams && player.nba_team ? { ...player, playing_now: knownLiveTeams.has(player.nba_team) } : player
        })
    }, [mergedSnapshot, players, scoring, now, leagueId, liveSeason])
    return { rows, onViewableItemsChanged }
}
