import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import type { FlashListRef } from '@shopify/flash-list'
import { useScreenView } from '@/hooks/use-screen-view'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { usePanelActivity } from '@/contexts/panel-activity'
import { readScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import { playerSupportData, type PlayersView } from '@/lib/cache/view-types'
import { applyVisiblePlayerTotals, type PlayerRow, type VisiblePlayerTotals } from '@/lib/players'
import type { OwnedEntry } from '@/lib/roster'
import { getWeekDays, type WeekDay } from '@/lib/lineup'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { todayET } from '@/lib/shared/dates'
import { currentSeasonYear } from '@/lib/shared/season'
import { activePlayerFilterCount, type PlayerAvailabilityFilter, type PlayerPlayingFilter, type PlayerSearchHealthFilter } from '@/lib/player-search-state'
import { PLAYER_SEARCH_SORT_OPTIONS, type PlayerSearchSortDir, type PlayerSearchSortMode } from '@/lib/player-search-sort'
import type { ScoringSettings } from '@pancake/core'

export const SORT_OPTIONS = PLAYER_SEARCH_SORT_OPTIONS
type PlayerTotalsSnapshot = { key: string; rows: Map<string, { row: VisiblePlayerTotals | null; readAt: number }> }

function playerScoringSettings(value: unknown): ScoringSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
}
export function useWeeklyAvailability(enabled: boolean, active = true) {
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [loading, setLoading] = useState(enabled)
    const [error, setError] = useState<Error | null>(null)
    const [loadedDay, setLoadedDay] = useState<string | null>(null)
    const [retryToken, setRetryToken] = useState(0)
    const retry = useCallback(() => setRetryToken(value => value + 1), [])

    useEffect(() => {
        if (!enabled) {
            setWeekDays([])
            setLoading(false)
            setError(null)
            setLoadedDay(null)
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
            if (!includeSchedule && loadedDate === todayET()) return
            const requestId = ++requestSequence
            setLoading(true)
            const seasonYear = currentSeasonYear()
            const today = todayET()
            try {
                const days = includeSchedule || loadedDate !== today
                    ? await getCurrentWeekNumber(seasonYear).then((weekNum) => getWeekDays(weekNum ?? 1, seasonYear))
                    : null
                if (cancelled || requestSequence !== requestId) return
                loadedDate = today
                setLoadedDay(today)
                setError(null)
                if (days) setWeekDays(days)
            } catch (error) {
                if (!cancelled && requestSequence === requestId) {
                    setError(error instanceof Error ? error : new Error(String(error)))
                    console.error(error)
                }
            } finally {
                if (!cancelled && requestSequence === requestId) setLoading(false)
            }
        }
        void load(true)
        const subscription = AppState.addEventListener('change', (nextState) => {
            const becameActive = appState !== 'active' && nextState === 'active'
            appState = nextState
            if (becameActive) void load(true)
        })
        return () => {
            cancelled = true
            requestSequence += 1
            subscription.remove()
        }
    }, [enabled, active, retryToken])

    return { weekDays, loading, error, retry, isSnapshot: loadedDay !== todayET() || loading || Boolean(error) }
}

export function usePlayerSearch(leagueId: string | null, _ownedMap: Map<string, OwnedEntry>, _waiverIds: Set<string>, currentMemberId?: string, options: { enabled?: boolean; online?: boolean; focused?: boolean; ownerId?: string; admitted?: boolean; initialLiveStats?: boolean; scoringSettings?: unknown } = {}) {
    const panelActive = usePanelActivity()
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
    const debouncedQuery = useDebouncedValue(query.trim(), 250)
    const listRef = useRef<FlashListRef<PlayerRow>>(null)
    const scope = options.ownerId && leagueId && currentMemberId ? screenScope('players', leagueId, currentMemberId, { query: debouncedQuery, position, teams: selectedTeams, playing: playingFilter, availability: availabilityFilter, rookiesOnly, health, sortBy: sortMode, sortDir, ...(seasonYear === null ? {} : { seasonYear }), limit: 20 }, options.ownerId) : null
    const enabled = options.enabled !== false && options.focused !== false && panelActive
    const view = useScreenView<PlayersView & { weekDays: WeekDay[] }>(scope, enabled)
    const refreshView = view.refresh
    const [page, setPage] = useState<{ base?: PlayersView; players: PlayerRow[]; offset: number; hasMore: boolean }>({ players: [], offset: 0, hasMore: false })
    const selected = useMemo(() => page.base === view.data ? page : { base: view.data, players: view.data?.players ?? [], offset: view.data?.players.length ?? 0, hasMore: view.data?.hasMore ?? false }, [page, view.data])
    const latest = useRef(selected)
    latest.current = selected
    const [loadingMore, setLoadingMore] = useState(false)
    const [pageError, setPageError] = useState<Error | null>(null)
    const sequence = useRef(0)
    const pending = useRef(false)
    useEffect(() => { sequence.current += 1; pending.current = false; setLoadingMore(false); setPageError(null) }, [view.data, leagueId, currentMemberId, options.ownerId])
    const retry = useCallback(() => { void refreshView(true) }, [refreshView])
    const refreshIfChanged = useCallback(() => { void refreshView() }, [refreshView])
    const loadMore = useCallback(async () => {
        const previous = latest.current
        if (!scope || !enabled || pending.current || !previous.hasMore) return
        const request = ++sequence.current
        pending.current = true
        setLoadingMore(true)
        try {
            const next = await readScreenView<PlayersView>({ ...scope, params: { ...scope.params, offset: previous.offset } })
            if (sequence.current !== request || latest.current !== previous) return
            const known = new Set(previous.players.map(player => player.id))
            setPage({ ...previous, players: [...previous.players, ...next.players.filter(player => !known.has(player.id))], offset: previous.offset + next.players.length, hasMore: next.hasMore })
            setPageError(null)
        } catch (cause) { if (sequence.current === request) setPageError(cause instanceof Error ? cause : new Error(String(cause))) }
        finally { if (sequence.current === request) { pending.current = false; setLoadingMore(false) } }
    }, [scope, enabled])
    const scoring = useMemo(() => playerScoringSettings(options.scoringSettings), [options.scoringSettings])
    const totals = useMemo(() => new Map((view.data?.visibleTotals ?? []).map(row => [row.player_id, row])), [view.data])
    const players = useMemo(() => selected.players.map(player => {
        const row = totals.get(player.id)
        return row ? applyVisiblePlayerTotals(player, row, scoring) : player
    }), [selected.players, totals, scoring])
    const support = useMemo(() => view.data ? playerSupportData(view.data) : null, [view.data])
    const totalsSnapshot = useMemo<PlayerTotalsSnapshot>(() => ({ key: JSON.stringify([JSON.stringify([options.ownerId, currentMemberId, leagueId]), leagueId, players[0]?.stats_season_year ?? seasonYear ?? currentSeasonYear()]), rows: new Map(players.map(player => [player.id, { row: totals.get(player.id) ?? null, readAt: Date.now() }])) }), [players, totals, options.ownerId, currentMemberId, leagueId, seasonYear])
    const activeFilterCount = useMemo(() => activePlayerFilterCount({ query, position, selectedTeams, playingFilter, availabilityFilter, rookiesOnly, health, sortMode, seasonYear }), [query, position, selectedTeams, playingFilter, availabilityFilter, rookiesOnly, health, sortMode, seasonYear])
    const clearAllFilters = useCallback(() => { setQuery(''); setPosition('ALL'); setSelectedTeams([]); setPlayingFilter('all'); setAvailabilityFilter('free_agents'); setRookiesOnly(false); setHealth('all'); setSortMode('fpts'); setSortDir('desc'); setSeasonYear(null) }, [])
    const error = view.error ?? pageError
    return { search: { query, setQuery }, position: { value: position, setValue: setPosition }, teamPicker: { selectedTeams, setSelectedTeams }, availability: { weekDays: view.data?.weekDays ?? [] }, playing: { value: playingFilter, setValue: setPlayingFilter }, sort: { mode: sortMode, setMode: setSortMode, dir: sortDir, setDir: setSortDir }, health: { value: health, setValue: setHealth }, availabilityFilter: { value: availabilityFilter, setValue: setAvailabilityFilter }, toggles: { rookiesOnly, setRookiesOnly }, season: { value: seasonYear, setValue: setSeasonYear }, results: { players, totalsSnapshot, loading: view.loading, refreshing: view.refreshing, loadingMore, error, listRef, loadMore, retry, refreshIfChanged, isSnapshot: view.offline || !view.loaded || Boolean(error) || query.trim() !== debouncedQuery }, activeFilterCount, clearAllFilters, support, refresh: refreshView }
}

export function useVisiblePlayerRows(players: PlayerRow[], _leagueId: string | null, _seasonYear: number | null, _scoringSettings: unknown, _options: { enabled: boolean; ownerKey: string; initialTotals?: PlayerTotalsSnapshot | null }) {
    const onViewableItemsChanged = useCallback((_info: { viewableItems: { item: PlayerRow; isViewable: boolean }[] }) => {}, [])
    return { rows: players, onViewableItemsChanged }
}
