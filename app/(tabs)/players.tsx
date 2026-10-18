import { useIsFocused } from '@react-navigation/native'
import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { type OwnedEntry } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { NoLeagueState } from '@/components/NoLeagueState'
import { FilterSelect, MultiSelect, Page, PageHeader, SegmentedControl, usePageMetrics } from '@/components/ui'
import { Sheet } from '@/components/ui/Sheet'
import { DynastyHub } from '@/components/dynasty/DynastyHub'
import { RetainedPanel } from '@/components/ui/RetainedPanel'
import { playerListStyles as styles } from '@/components/ui/playerListStyles'
import { NBA_TEAM_OPTIONS } from '@/constants/nba'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { usePlayerSearch, SORT_OPTIONS } from '@/hooks/use-player-search'
import { useAuth } from '@/hooks/use-auth'
import { STAT_COLUMN_SORT, type PlayerSearchSortMode } from '@/lib/player-search-sort'
import { playerSeasonFilterOptions, seasonLabel } from '@/lib/player-search-state'
import { todayET } from '@/lib/shared/dates'
import { currentSeasonYear } from '@/lib/shared/season'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { addLimitSummary } from '@/lib/pickup'
import { PlayerRow } from '@/lib/players'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { browserReadsAllowed } from '@/hooks/use-browser-read-activity'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { loadPlayerSupport, type PlayerSupport, type PlayerSupportResource } from '@/lib/player-availability'
import { readTabSnapshot, tabSnapshotRevision, tabSnapshotScope, writeTabSnapshot } from '@/lib/tab-snapshot'
import { invalidateLeagueSnapshot, waitForLeagueChanges } from '@/lib/league-changes'
import { usePlayerSupportRealtime } from '@/hooks/use-player-support-realtime'

const POSITIONS = [
    { key: 'ALL', label: 'All' },
    { key: 'PG', label: 'PG' },
    { key: 'SG', label: 'SG' },
    { key: 'SF', label: 'SF' },
    { key: 'PF', label: 'PF' },
    { key: 'C', label: 'C' },
    { key: 'G', label: 'G' },
    { key: 'F', label: 'F' },
] as const
const AVAILABILITY_FILTERS = [
    { key: 'all', label: 'All players' },
    { key: 'free_agents', label: 'Free agents' },
    { key: 'waivers', label: 'On waivers' },
    { key: 'rostered', label: 'Rostered' },
    { key: 'mine', label: 'My team' },
] as const
const HEALTH_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'healthy', label: 'Healthy' },
    { key: 'gtd', label: 'Game-time' },
    { key: 'out', label: 'Out' },
    { key: 'ir', label: 'IR' },
] as const
const PLAYING_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'today', label: 'Playing today' },
    { key: 'not_today', label: 'Not playing' },
] as const
const CLASS_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'rookies', label: 'Rookies only' },
] as const
const SEASON_YEAR = currentSeasonYear()
const SEASON_FILTERS = playerSeasonFilterOptions(SEASON_YEAR)
const TABLE_COLUMNS = ['FP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP']
const STAT_LABELS: Record<string, string> = {
    FP: 'Fantasy points', PTS: 'Points', REB: 'Rebounds', AST: 'Assists', STL: 'Steals',
    BLK: 'Blocks', '3PM': 'Three-pointers made', TO: 'Turnovers', GP: 'Games played', MIN: 'Minutes',
}

const EMPTY_OWNED_MAP = new Map<string, OwnedEntry>()
const EMPTY_WAIVER_IDS = new Set<string>()

type PlayerSupportCache = Pick<PlayerSupport, 'seasonId' | 'memberId' | 'day'> & {
    ownedEntries: [string, OwnedEntry][]
    waiverIds: string[]
    waiverClearsAtEntries: [string, string][]
    pendingClaimIds: string[]
    transactionState: PlayerSupport['transactionState']
}
const SUPPORT_CACHE_PREFIX = 'pancake:player-support:v4:'
const supportCacheKey = (memberId: string, leagueId: string) => `${SUPPORT_CACHE_PREFIX}${leagueId}:${memberId}`

function PlayerTableHeader({
    activeSort,
    sortDir,
    onColumnSort,
}: {
    activeSort?: PlayerSearchSortMode
    sortDir?: 'asc' | 'desc'
    onColumnSort?: (mode: PlayerSearchSortMode) => void
}) {
    return (
        <View style={styles.tableHeader}>
            <View style={styles.tableHeaderAddSpacer} />
            <View style={styles.tableHeaderCardRow}>
                <View style={styles.tableHeaderHeadshotSpacer} />
                <Text style={styles.tableHeaderPlayer}>Player</Text>
                <Text style={styles.tableHeaderOwnership}>Ownership</Text>
                <View style={styles.tableHeaderStatsGroup}>
                    {TABLE_COLUMNS.map((column) => {
                        const mode = STAT_COLUMN_SORT[column]
                        const active = mode != null && activeSort === mode
                        const disabled = mode == null || !onColumnSort
                        return (
                            <Pressable
                                key={column}
                                style={styles.tableHeaderStatBtn}
                                onPress={() => mode && onColumnSort?.(mode)}
                                disabled={disabled}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active, disabled }}
                                accessibilityLabel={mode
                                    ? `Sort by ${STAT_LABELS[column] ?? column}${active && sortDir ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`
                                    : STAT_LABELS[column] ?? column}
                            >
                                <Text style={[styles.tableHeaderStat, active && styles.tableHeaderStatActive]} numberOfLines={1}>
                                    {column}{active && sortDir ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
            </View>
        </View>
    )
}

function PlayerSearchSection() {
    const { push } = useRouter()
    const { user, loading: authLoading } = useAuth()
    const { memberships, current, currentLeague, loading: leagueLoading, online, membershipValidated } = useLeagueContext()
    const focused = useIsFocused()
    const { width } = useWindowDimensions()
    const leagueId = currentLeague?.id ?? null
    const readGeneration = sessionGeneration()
    const searchEnabled = membershipValidated && !!user && !!current?.id && !!leagueId
    const { compact: compactToolbar, padX } = usePageMetrics()
    const showStatTable = width >= 1180
    // Phones keep search on screen and move the filters into a sheet; wider
    // screens show every filter as a chip in one toolbar row.
    const [filtersOpen, setFiltersOpen] = useState(false)

    const snapshotScope = tabSnapshotScope(user?.id, current?.id, leagueId ?? undefined, currentLeague)
    const cachedSupport = useMemo(() => {
        if (!current?.id || !leagueId) return undefined
        const cached = readTabSnapshot<PlayerSupportCache>(supportCacheKey(current.id, leagueId), snapshotScope, leagueId, 'support', current.id)
        if (!cached) return undefined
        const value = cached.data
        return { savedAt: cached.savedAt, data: {
            leagueId, seasonId: value.seasonId, memberId: value.memberId, day: value.day,
            ownedMap: new Map(value.ownedEntries),
            waiverIds: new Set(value.waiverIds),
            waiverClearsAt: new Map(value.waiverClearsAtEntries),
            pendingClaimIds: new Set(value.pendingClaimIds),
            transactionState: value.transactionState,
        } }
    }, [current?.id, leagueId, snapshotScope])

    const supportReads = useRef<{ scope: string; previous?: PlayerSupport | null; resources?: Set<PlayerSupportResource>; forceFull?: boolean; savedAt: number }>({ scope: snapshotScope, previous: cachedSupport?.data, forceFull: !cachedSupport?.savedAt, savedAt: cachedSupport?.savedAt ?? 0 })
    if (supportReads.current.scope !== snapshotScope) supportReads.current = { scope: snapshotScope, previous: cachedSupport?.data, forceFull: !cachedSupport?.savedAt, savedAt: cachedSupport?.savedAt ?? 0 }
    const {
        data: playerSupport,
        loading: playerSupportFetchLoading,
        error: playerSupportError,
        refresh: refreshSupportSnapshot,
        refreshIfStale: refreshSupportIfStale,
        isSnapshot: supportSnapshot,
        markStale: markSupportStale,
    } = useFocusAsyncData<PlayerSupport>(async () => {
        if (!leagueId) {
            return {
                leagueId: null, seasonId: null, memberId: current?.id ?? null, day: todayET(),
                ownedMap: new Map<string, OwnedEntry>(),
                waiverIds: new Set<string>(),
                waiverClearsAt: new Map<string, string>(),
                pendingClaimIds: new Set<string>(),
                transactionState: null,
            }
        }
        const reads = supportReads.current
        const resources = !reads.forceFull && Date.now() - reads.savedAt < 300_000 && reads.resources ? [...reads.resources] : undefined
        reads.forceFull = true
        reads.resources = undefined
        return loadPlayerSupport(current?.id, leagueId, { previous: reads.previous, resources, canRead: () => browserReadsAllowed() && supportReads.current.scope === snapshotScope && readGeneration === sessionGeneration() })
    }, [current?.id, leagueId, snapshotScope, readGeneration], {
        enabled: focused && membershipValidated && searchEnabled,
        followSourceChanges: true,
        beforeRead: () => leagueId ? waitForLeagueChanges(leagueId) : Promise.resolve(),
        initialData: cachedSupport?.data, initialFetchedAt: cachedSupport?.savedAt, staleMs: 300_000,
        cacheRevision: () => leagueId ? tabSnapshotRevision(leagueId, 'support', current?.id) : null,
        onFailed: () => { supportReads.current.forceFull = true; if (leagueId) invalidateLeagueSnapshot(leagueId) },
        onLoaded: (support, revision) => {
            supportReads.current.previous = support
            supportReads.current.savedAt = Date.now()
            supportReads.current.forceFull = revision !== (leagueId ? tabSnapshotRevision(leagueId, 'support', current?.id) : null)
            if (current?.id && leagueId) {
                writeTabSnapshot<PlayerSupportCache>(supportCacheKey(current.id, leagueId), snapshotScope, revision, {
                    seasonId: support.seasonId, memberId: support.memberId, day: support.day,
                    ownedEntries: Array.from(support.ownedMap.entries()),
                    waiverIds: Array.from(support.waiverIds),
                    waiverClearsAtEntries: Array.from(support.waiverClearsAt.entries()),
                    pendingClaimIds: Array.from(support.pendingClaimIds),
                    transactionState: support.transactionState,
                })
            }
        },
    })


    const refreshPlayerSupport = useCallback(() => {
        supportReads.current.resources = undefined
        supportReads.current.forceFull = true
        return refreshSupportSnapshot()
    }, [refreshSupportSnapshot])
    const invalidateSupport = useCallback((resources: readonly PlayerSupportResource[] | null) => {
        markSupportStale()
        if (!resources) { supportReads.current.forceFull = true; supportReads.current.resources = undefined; return }
        supportReads.current.resources ??= new Set()
        for (const resource of resources) supportReads.current.resources.add(resource)
    }, [markSupportStale])
    const refreshSupportResources = useCallback(() => refreshSupportIfStale(), [refreshSupportIfStale])
    const playerSupportForLeague = playerSupport?.leagueId === leagueId ? playerSupport : null
    const ownedMap = playerSupportForLeague?.ownedMap ?? EMPTY_OWNED_MAP
    const waiverIds = playerSupportForLeague?.waiverIds ?? EMPTY_WAIVER_IDS
    const playerSupportLoading = !!leagueId && playerSupportFetchLoading && playerSupportForLeague == null
    const playerSupportReady = !leagueId || playerSupportForLeague != null
    const transactionState = playerSupportForLeague?.transactionState ?? null

    const search = usePlayerSearch(leagueId, ownedMap, waiverIds, current?.id, { enabled: searchEnabled && playerSupportReady, admitted: !supportSnapshot && !playerSupportFetchLoading, online, focused, ownerId: user?.id })
    const retrySearch = search.results.retry
    const refreshPlayers = useCallback(() => {
        const support = refreshPlayerSupport()
        retrySearch()
        return support
    }, [retrySearch, refreshPlayerSupport])

    const refreshChangedSearch = search.results.refreshIfChanged
    const recoverPlayerResources = useCallback(() => {
        const support = refreshSupportIfStale()
        refreshChangedSearch()
        return support
    }, [refreshChangedSearch, refreshSupportIfStale])
    usePlayerSupportRealtime(current?.id, leagueId, refreshSupportResources, recoverPlayerResources, focused, playerSupportForLeague?.seasonId, refreshChangedSearch, invalidateSupport)

    // ESPN-style column sort: click a stat header to sort the whole pool by it;
    // click the active one again to flip direction. All stats default to
    // descending (best first).
    const handleColumnSort = (mode: PlayerSearchSortMode) => {
        if (search.sort.mode === mode) {
            search.sort.setDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
        } else {
            search.sort.setMode(mode)
            search.sort.setDir('desc')
        }
    }
    const openClaim = useCallback((player: Pick<PlayerRow, 'id'>) => {
        push(`/(modals)/claim-player?playerId=${player.id}`)
    }, [push])
    const quickAdd = useQuickAdd({
        memberId: current?.id,
        leagueId,
        onChanged: refreshPlayerSupport,
        transactionState,
        onClaimInstead: openClaim,
    })
    const availabilityUpdating = supportSnapshot || playerSupportFetchLoading
    const addBlockedReason = quickAdd.addBlockedReason
    const { handleAdd: quickAddHandleAdd, handleClaim: quickAddHandleClaim } = quickAdd
    const handleAddPlayer = useCallback((player: PlayerRow) => {
        if (!online || availabilityUpdating) return
        if (playerSupportForLeague?.pendingClaimIds.has(player.id)) push('/roster?claims=1')
        else if (waiverIds.has(player.id)) void quickAddHandleClaim(player)
        else void quickAddHandleAdd(player)
    }, [online, availabilityUpdating, waiverIds, playerSupportForLeague?.pendingClaimIds, push, quickAddHandleClaim, quickAddHandleAdd])
    const handleOpenPlayer = useCallback((player: PlayerRow) => {
        push(`/player/${player.id}`)
    }, [push])
    const renderPlayerItem = useCallback(({ item }: { item: PlayerRow }) => (
        <PlayerSearchItem
            item={item}
            currentMemberId={current?.id}
            ownedMap={ownedMap}
            waiverIds={waiverIds}
            waiverClearsAt={playerSupportForLeague?.waiverClearsAt.get(item.id) ?? null}
            claimPending={playerSupportForLeague?.pendingClaimIds.has(item.id) ?? false}
            isAdding={quickAdd.adding === item.id}
            addDisabled={!online || availabilityUpdating}
            showStats={showStatTable}
            showCompactStats={false}
            animate={false}
            addBlockedReason={addBlockedReason}
            onAdd={handleAddPlayer}
            onPress={handleOpenPlayer}
        />
    ), [current?.id, online, availabilityUpdating, ownedMap, waiverIds, playerSupportForLeague?.waiverClearsAt, playerSupportForLeague?.pendingClaimIds, quickAdd.adding, showStatTable, addBlockedReason, handleAddPlayer, handleOpenPlayer])
    const playerListExtraData = [
        search.sort.mode,
        search.sort.dir,
        search.availabilityFilter.value,
        search.playing.value,
        search.health.value,
        search.teamPicker.selectedTeams.join(','),
        search.season.value ?? '',
    ].join('|')
    const showInitialShell = authLoading || (leagueLoading && memberships.length === 0)
    const resultCount = search.results.players.length
    const resultCountLabel = search.results.loading && resultCount === 0
        ? '— players'
        : `${resultCount}${search.activeFilterCount > 0 ? ' filtered' : ''} player${resultCount === 1 ? '' : 's'}`
    const waiverLine = transactionState
        ? transactionState.waiverMode === 'faab'
            ? `FAAB $${transactionState.faabBalance}`
            : 'Rolling waivers'
        : 'Waivers —'
    const seasonNote = search.season.value === null ? '' : ` · ${seasonLabel(search.season.value)} stats`
    const summaryLine = `${resultCountLabel}${seasonNote} · ${addLimitSummary(transactionState)} · ${waiverLine}`
    const filterControls = (variant: 'chip' | 'field') => (
        <>
            <FilterSelect
                variant={variant}
                label="Availability"
                value={search.availabilityFilter.value}
                options={AVAILABILITY_FILTERS}
                onChange={search.availabilityFilter.setValue}
            />
            <FilterSelect
                variant={variant}
                label="Position"
                value={search.position.value}
                options={POSITIONS}
                onChange={search.position.setValue}
            />
            <MultiSelect
                variant={variant}
                label="Team"
                options={NBA_TEAM_OPTIONS}
                selected={search.teamPicker.selectedTeams}
                onChange={search.teamPicker.setSelectedTeams}
                pluralLabel="teams"
                clearAccessibilityLabel="Clear teams"
            />
            <FilterSelect
                variant={variant}
                label="Health"
                value={search.health.value}
                options={HEALTH_FILTERS}
                onChange={search.health.setValue}
            />
            <FilterSelect
                variant={variant}
                label="Game today"
                value={search.playing.value}
                options={PLAYING_FILTERS}
                onChange={search.playing.setValue}
            />
            <FilterSelect
                variant={variant}
                label="Experience"
                value={search.toggles.rookiesOnly ? 'rookies' : 'all'}
                options={CLASS_FILTERS}
                onChange={(value) => search.toggles.setRookiesOnly(value === 'rookies')}
            />
            <FilterSelect
                variant={variant}
                label="Season"
                value={String(search.season.value ?? SEASON_YEAR)}
                options={SEASON_FILTERS}
                onChange={(value) => search.season.setValue(Number(value) === SEASON_YEAR ? null : Number(value))}
            />
        </>
    )
    const listIsInitialLoading = playerSupportLoading || (search.results.loading && search.results.players.length === 0)

    // No placeholder shell while auth/league context loads — the screen stays
    // blank and the real UI appears fully formed, with no reflow.
    if (showInitialShell) {
        return <View style={styles.container} />
    }
    if (!user) return <NoLeagueState />
    if (memberships.length === 0 || !current || !leagueId) return <NoLeagueState />

    return (
        <View style={styles.container}>
          <View style={styles.contentWrap}>
            <View style={[localStyles.toolbar, { paddingHorizontal: padX }]}>
                <View style={localStyles.toolbarRow}>
                    <TextInput
                        style={[styles.searchInput, !compactToolbar && localStyles.searchWide]}
                        placeholder="Search players..."
                        placeholderTextColor={colors.inputPlaceholder}
                        value={search.search.query}
                        onChangeText={search.search.setQuery}
                        autoCorrect={false}
                        clearButtonMode="while-editing"
                        accessibilityLabel="Search players"
                    />
                    {compactToolbar ? (
                        <Pressable
                            style={[localStyles.filterButton, search.activeFilterCount > 0 && localStyles.filterButtonActive]}
                            onPress={() => setFiltersOpen(true)}
                            accessibilityRole="button"
                            accessibilityLabel="Show filters"
                        >
                            <Text style={[localStyles.filterButtonText, search.activeFilterCount > 0 && localStyles.filterButtonTextActive]}>Filters</Text>
                            {search.activeFilterCount > 0 ? (
                                <View style={styles.filterCountDot}>
                                    <Text style={styles.filterCountDotText}>{search.activeFilterCount}</Text>
                                </View>
                            ) : null}
                        </Pressable>
                    ) : (
                        <>
                            {filterControls('chip')}
                            {search.activeFilterCount > 0 ? (
                                <Pressable onPress={search.clearAllFilters} style={localStyles.clearButton} accessibilityRole="button" accessibilityLabel="Clear all filters">
                                    <Text style={localStyles.clearButtonText}>Clear</Text>
                                </Pressable>
                            ) : null}
                            <Text style={[localStyles.summary, localStyles.summaryWide]} numberOfLines={1}>{summaryLine}</Text>
                        </>
                    )}
                </View>
                {compactToolbar ? <Text style={localStyles.summary} numberOfLines={1}>{summaryLine}</Text> : null}
                {addBlockedReason ? (
                    <Text
                        style={localStyles.addLimitNotice}
                        accessibilityLiveRegion="polite"
                        role="status"
                        testID="add-limit-notice"
                    >
                        {addBlockedReason}
                    </Text>
                ) : null}
            </View>

            {search.results.players.length > 0 && (!online || search.results.error || playerSupportError) && <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh player data"
                disabled={!online || search.results.refreshing}
                onPress={() => { void refreshPlayers() }}
                style={localStyles.freshness}
            >
                <Text style={localStyles.freshnessText} accessibilityLiveRegion="polite">
                    {!online ? 'Offline. Saved player results may be out of date.'
                        : 'Player refresh failed. Saved results may be out of date. Tap to retry.'}
                </Text>
            </Pressable>}
            <Sheet visible={compactToolbar && filtersOpen} title="Filters" onClose={() => setFiltersOpen(false)}>
                <View style={localStyles.sheetFields}>
                    {filterControls('field')}
                    <FilterSelect
                        label="Sort"
                        value={search.sort.mode}
                        options={SORT_OPTIONS}
                        onChange={(value) => {
                            search.sort.setMode(value)
                            search.sort.setDir('desc')
                        }}
                    />
                    <Pressable
                        style={[styles.sortDirButton, localStyles.sortDirInSheet]}
                        onPress={() => search.sort.setDir((dir) => dir === 'asc' ? 'desc' : 'asc')}
                        accessibilityRole="button"
                    >
                        <Text style={styles.sortDirText}>{search.sort.dir === 'asc' ? 'Lowest first ↑' : 'Highest first ↓'}</Text>
                    </Pressable>
                </View>
                <View style={localStyles.sheetActions}>
                    {search.activeFilterCount > 0 ? (
                        <Pressable onPress={search.clearAllFilters} style={localStyles.sheetClear} accessibilityRole="button" accessibilityLabel="Clear all filters">
                            <Text style={localStyles.clearButtonText}>Clear all</Text>
                        </Pressable>
                    ) : null}
                    <Pressable onPress={() => setFiltersOpen(false)} style={localStyles.sheetDone} accessibilityRole="button">
                        <Text style={localStyles.sheetDoneText}>{`Show ${resultCountLabel}`}</Text>
                    </Pressable>
                </View>
            </Sheet>

            <FlashList
                    ref={search.results.listRef}
                    data={search.results.players}
                    extraData={playerListExtraData}
                    keyExtractor={(p: PlayerRow) => p.id}
                    contentContainerStyle={search.results.players.length === 0 && !listIsInitialLoading ? styles.emptyContainer : undefined}
                    ItemSeparatorComponent={ItemSeparator}
                    ListHeaderComponent={showStatTable ? (
                        <PlayerTableHeader activeSort={search.sort.mode} sortDir={search.sort.dir} onColumnSort={handleColumnSort} />
                    ) : null}
                    renderItem={renderPlayerItem}
                    ListEmptyComponent={
                        !online
                            ? <EmptyState message="Offline. No saved player results." description="Reconnect to load this search." fullScreen={false} />
                            : listIsInitialLoading
                            ? null
                            : search.results.error
                              ? <EmptyState message="Players could not load." description={search.results.error.message} actionLabel="Retry" onAction={search.results.retry} fullScreen={false} />
                            : playerSupportError && playerSupportForLeague == null
                              ? <EmptyState message="Players could not load." description="Tap retry to reload roster and waiver state." actionLabel="Retry" onAction={() => void refreshPlayerSupport()} fullScreen={false} />
                            : search.activeFilterCount > 0
                              ? <EmptyState message="No players match these filters." actionLabel="Clear filters" onAction={search.clearAllFilters} fullScreen={false} />
                            : search.search.query.trim()
                              ? <EmptyState message={`No players match "${search.search.query.trim()}".`} actionLabel="Clear search" onAction={() => search.search.setQuery('')} fullScreen={false} />
                            : search.availabilityFilter.value === 'free_agents'
                              ? <EmptyState message="No free agents right now." description="Every player is on a roster or on waivers." actionLabel="Show all players" onAction={() => search.availabilityFilter.setValue('all')} fullScreen={false} />
                            : <EmptyState message="No players found." fullScreen={false} />
                    }
                    onEndReached={search.results.loadMore}
                    onEndReachedThreshold={0.3}
                    ListFooterComponent={null}
                />
          </View>

            <DropPlayerPickerModal
                visible={quickAdd.dropPickerPlayer !== null}
                title={`Drop a player to add\n${quickAdd.dropPickerPlayer?.display_name ?? ''}`}
                subtitle="Your roster is full. Pick someone to release."
                roster={quickAdd.myRoster}
                dropping={quickAdd.dropping}
                onDrop={quickAdd.handleDropAndAdd}
                onCancel={() => quickAdd.setDropPickerPlayer(null)}
            />

            <IRResolutionModal
                visible={quickAdd.irModal !== null}
                ineligibleIR={quickAdd.irModal?.ineligible ?? []}
                activeRoster={(quickAdd.irModal?.roster ?? []).filter((r) => !r.is_on_ir && !r.is_on_taxi)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={quickAdd.irModal?.pendingPlayer.display_name ?? ''}
                onActivate={quickAdd.handleIRActivate}
                onDropAndActivate={quickAdd.handleDropAndIRActivate}
                onCancel={() => quickAdd.setIrModal(null)}
            />
        </View>
    )
}

type PlayersSection = 'players' | 'rankings' | 'news'
const SECTIONS: PlayersSection[] = ['players', 'rankings', 'news']

function initialSection(value: string | string[] | undefined): PlayersSection {
    return SECTIONS.find((section) => section === value) ?? 'players'
}

/**
 * Everything about players in one place: the searchable pool, dynasty
 * rankings, and news. A section mounts the first time it is opened and stays
 * mounted, so switching back keeps its search, filters, and scroll.
 */
export default function PlayersScreen() {
    const focused = useIsFocused()
    const params = useLocalSearchParams<{ section?: string }>()
    const { user, loading: authLoading } = useAuth()
    const { memberships, loading: leagueLoading } = useLeagueContext()
    const [section, setSection] = useState<PlayersSection>(() => initialSection(params.section))
    const [opened, setOpened] = useState<Set<PlayersSection>>(() => new Set([initialSection(params.section)]))

    useEffect(() => {
        if (!params.section) return
        const next = initialSection(params.section)
        setSection(next)
        setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
    }, [params.section])

    const [lastDynasty, setLastDynasty] = useState<'rankings' | 'news'>('rankings')
    const openSection = useCallback((next: PlayersSection) => {
        if (next !== 'players') setLastDynasty(next)
        setSection(next)
        setOpened((prev) => (prev.has(next) ? prev : new Set(prev).add(next)))
    }, [])

    if (authLoading || (leagueLoading && memberships.length === 0)) return <View style={styles.container} />
    if (!user || memberships.length === 0) return <NoLeagueState />

    return (
        <Page title="Players">
            <PageHeader
                tabs={(
                    <SegmentedControl<PlayersSection>
                        variant="tabs"
                        value={section}
                        onChange={openSection}
                        options={[
                            { label: 'Players', value: 'players' },
                            { label: 'Rankings', value: 'rankings' },
                            { label: 'News', value: 'news' },
                        ]}
                        accessibilityLabel="Players sections"
                        idBase="players-section"
                        controlledPanelId="players-section-panel"
                        scrollable
                    />
                )}
            />
            <View style={localStyles.panel} nativeID="players-section-panel" role="tabpanel">
                {opened.has('players') ? (
                    <RetainedPanel active={focused && section === 'players'}>
                        <PlayerSearchSection />
                    </RetainedPanel>
                ) : null}
                {/* Rankings and News share one instance, so each loads its data once. */}
                {opened.has('rankings') || opened.has('news') ? (
                    <RetainedPanel active={focused && section !== 'players'}>
                        <DynastyHub section={section === 'news' || (section === 'players' && lastDynasty === 'news') ? 'news' : 'rankings'} />
                    </RetainedPanel>
                ) : null}
            </View>
        </Page>
    )
}

const localStyles = StyleSheet.create({
    freshness: { paddingVertical: spacing.sm },
    freshnessText: { fontSize: fontSize.sm, color: colors.textSecondary },
    panel: { flex: 1, minHeight: 0 },
    toolbar: {
        gap: spacing.xs,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    toolbarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.sm,
    },
    searchWide: { flexGrow: 0, flexBasis: 280, minWidth: 220, height: 36 },
    filterButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    filterButtonActive: { backgroundColor: colors.primaryLight, borderColor: colors.primaryBorder },
    filterButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    filterButtonTextActive: { color: colors.primaryDark },
    clearButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.md },
    clearButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.dangerDark },
    summary: { ...textStyles.meta },
    summaryWide: { marginLeft: 'auto', flexShrink: 0 },
    // Two fields per row; each field sets its own basis so the grid wraps evenly.
    sheetFields: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
    sheetActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
    sortDirInSheet: { flexGrow: 1, flexBasis: 140, minHeight: 44 },
    sheetClear: {
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    sheetDone: {
        flex: 1,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.primary,
    },
    sheetDoneText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textWhite },
    addLimitNotice: {
        marginTop: spacing.xs,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: colors.warningDark,
    },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
