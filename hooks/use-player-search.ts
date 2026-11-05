import type { StatsWindowDays } from '@/lib/stats-window'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FlashListRef } from '@shopify/flash-list'
import { useScreenView } from '@/hooks/use-screen-view'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { usePanelActivity } from '@/contexts/panel-activity'
import { cachedScreenView, readScreenView, saveScreenView, screenCacheKey } from '@/lib/cache/screen-cache'
import { mergePlayerPage, playerPageOffset, type PlayerPages } from '@/lib/cache/player-pages'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { screenScope } from '@/lib/cache/screen-scope'
import { playerSupportData, type PlayersView } from '@/lib/cache/view-types'
import { applyVisiblePlayerTotals, type PlayerRow, type VisiblePlayerTotals } from '@/lib/players'
import type { OwnedEntry } from '@/lib/roster'
import type { WeekDay } from '@/lib/lineup'
import { useLeagueDay } from '@/hooks/use-league-day'
import { currentSeasonYear } from '@/lib/shared/season'
import { activePlayerFilterCount, type PlayerAvailabilityFilter, type PlayerPlayingFilter, type PlayerSearchHealthFilter } from '@/lib/player-search-state'
import { PLAYER_SEARCH_SORT_OPTIONS, readPlayerSort, savePlayerSort, compareDynastyPlayers, type PlayerSearchSortDir, type PlayerSearchSortMode } from '@/lib/player-search-sort'
import type { ScoringSettings } from '@pancake/core'

export const SORT_OPTIONS = PLAYER_SEARCH_SORT_OPTIONS
type PlayerTotalsSnapshot = { key: string; rows: Map<string, { row: VisiblePlayerTotals | null; readAt: number }> }

function playerScoringSettings(value: unknown): ScoringSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
}

export function usePlayerSearch(leagueId: string | null, _ownedMap: Map<string, OwnedEntry>, _waiverIds: Set<string>, currentMemberId?: string, options: { enabled?: boolean; online?: boolean; focused?: boolean; ownerId?: string; admitted?: boolean; initialLiveStats?: boolean; scoringSettings?: unknown } = {}) {
    const panelActive = usePanelActivity()
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [selectedTeams, setSelectedTeams] = useState<string[]>([])
    const [playingFilter, setPlayingFilter] = useState<PlayerPlayingFilter>('all')
    const [sortMode, setSortMode] = useState<PlayerSearchSortMode>(() => readPlayerSort().mode)
    const [sortDir, setSortDir] = useState<PlayerSearchSortDir>(() => readPlayerSort().dir)
    useEffect(() => { savePlayerSort({ mode: sortMode, dir: sortDir }) }, [sortMode, sortDir])
    const [health, setHealth] = useState<PlayerSearchHealthFilter>('all')
    const [availabilityFilter, setAvailabilityFilter] = useState<PlayerAvailabilityFilter>('free_agents')
    const [rookiesOnly, setRookiesOnly] = useState(false)
    const [selectedStatsDays, setStatsDays] = useState<StatsWindowDays>(null)
    const statsDays = availabilityFilter === 'mine' ? null : selectedStatsDays
    const statsDate = useLeagueDay('America/New_York')
    const [seasonYear, setSeasonYear] = useState<number | null>(null)
    const debouncedQuery = useDebouncedValue(query.trim(), 250)
    const listRef = useRef<FlashListRef<PlayerRow>>(null)
    const scope = options.ownerId && leagueId && currentMemberId ? screenScope('players', leagueId, currentMemberId, { query: debouncedQuery, position, teams: selectedTeams, playing: playingFilter, availability: availabilityFilter, rookiesOnly, health, sortBy: sortMode, sortDir, ...(statsDays === null ? (seasonYear === null ? {} : { seasonYear }) : { statsDays, statsDate }), limit: 20 }, options.ownerId) : null
    const enabled = options.enabled !== false && options.focused !== false && panelActive
    const view = useScreenView<PlayersView & { weekDays: WeekDay[] }>(scope, enabled)
    const refreshView = view.refresh
    const key = scope ? screenCacheKey(scope) : null
    const generation = sessionGeneration()
    const latestKey = useRef(key)
    latestKey.current = key
    const [loadingMore, setLoadingMore] = useState(false)
    const [pageError, setPageError] = useState<Error | null>(null)
    const sequence = useRef(0)
    const pending = useRef(false)
    useEffect(() => { sequence.current += 1; pending.current = false; setLoadingMore(false); setPageError(null) }, [key, generation])
    const retry = useCallback(() => { setPageError(null); void refreshView(true) }, [refreshView])
    const refreshIfChanged = useCallback(() => { void refreshView() }, [refreshView])
    const loadMore = useCallback(async () => {
        if (!scope || !enabled || pending.current) return
        const previous = cachedScreenView<PlayerPages>(scope)?.value
        if (!previous?.hasMore) return
        const offset = playerPageOffset(previous)
        const request = ++sequence.current
        pending.current = true
        setLoadingMore(true)
        try {
            const nextScope = { ...scope, params: { ...scope.params, offset } }
            const next = await readScreenView<PlayersView>(nextScope)
            if (sequence.current !== request || latestKey.current !== key || sessionGeneration() !== generation) return
            const current = cachedScreenView<PlayerPages>(scope)
            if (!current) return
            if (playerPageOffset(current.value) <= offset) {
                saveScreenView(scope, mergePlayerPage(current.value, next, offset), cachedScreenView(nextScope)?.version ?? current.version)
            }
            setPageError(null)
        } catch (cause) { if (sequence.current === request) setPageError(cause instanceof Error ? cause : new Error(String(cause))) }
        finally { if (sequence.current === request) { pending.current = false; setLoadingMore(false) } }
    }, [scope, enabled, key, generation])
    const scoring = useMemo(() => playerScoringSettings(options.scoringSettings), [options.scoringSettings])
    const totals = useMemo(() => new Map((view.data?.visibleTotals ?? []).map(row => [row.player_id, row])), [view.data])
    const players = useMemo(() => (sortMode === 'dynasty' ? [...(view.data?.players ?? [])].sort(compareDynastyPlayers) : (view.data?.players ?? [])).map(player => {
        const row = totals.get(player.id)
        return row && statsDays === null ? applyVisiblePlayerTotals(player, row, scoring) : player
    }), [view.data?.players, totals, scoring, sortMode, statsDays])
    const support = useMemo(() => view.data ? playerSupportData(view.data) : null, [view.data])
    const totalsSnapshot = useMemo<PlayerTotalsSnapshot>(() => ({ key: JSON.stringify([JSON.stringify([options.ownerId, currentMemberId, leagueId]), leagueId, players[0]?.stats_season_year ?? seasonYear ?? currentSeasonYear()]), rows: new Map(players.map(player => [player.id, { row: totals.get(player.id) ?? null, readAt: Date.now() }])) }), [players, totals, options.ownerId, currentMemberId, leagueId, seasonYear])
    const activeFilterCount = useMemo(() => activePlayerFilterCount({ query, position, selectedTeams, playingFilter, availabilityFilter, rookiesOnly, health, sortMode, seasonYear, statsDays }), [query, position, selectedTeams, playingFilter, availabilityFilter, rookiesOnly, health, sortMode, seasonYear, statsDays])
    const clearAllFilters = useCallback(() => { setQuery(''); setPosition('ALL'); setSelectedTeams([]); setPlayingFilter('all'); setAvailabilityFilter('free_agents'); setRookiesOnly(false); setHealth('all'); setSortMode('fpts'); setSortDir('desc'); setSeasonYear(null); setStatsDays(null) }, [])
    const error = view.error ?? pageError
    return { search: { query, setQuery }, position: { value: position, setValue: setPosition }, teamPicker: { selectedTeams, setSelectedTeams }, availability: { weekDays: view.data?.weekDays ?? [] }, playing: { value: playingFilter, setValue: setPlayingFilter }, sort: { mode: sortMode, setMode: setSortMode, dir: sortDir, setDir: setSortDir }, health: { value: health, setValue: setHealth }, availabilityFilter: { value: availabilityFilter, setValue: setAvailabilityFilter }, toggles: { rookiesOnly, setRookiesOnly }, season: { value: seasonYear, setValue: setSeasonYear }, statsWindow: { days: statsDays, setDays: setStatsDays, range: view.data?.statsWindow }, results: { players, totalsSnapshot, loading: view.loading, refreshing: view.refreshing, loadingMore, error, listRef, loadMore, retry, refreshIfChanged, isSnapshot: view.offline || !view.loaded || Boolean(error) || query.trim() !== debouncedQuery }, activeFilterCount, clearAllFilters, support, refresh: refreshView }
}

export function useVisiblePlayerRows(players: PlayerRow[], _leagueId: string | null, _seasonYear: number | null, _scoringSettings: unknown, _options: { enabled: boolean; ownerKey: string; initialTotals?: PlayerTotalsSnapshot | null }) {
    const onViewableItemsChanged = useCallback((_info: { viewableItems: { item: PlayerRow; isViewable: boolean }[] }) => {}, [])
    return { rows: players, onViewableItemsChanged }
}
