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
import { playerListStyles as styles } from '@/components/ui/playerListStyles'
import { NBA_TEAM_OPTIONS } from '@/constants/nba'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { usePlayerSearch, SORT_OPTIONS } from '@/hooks/use-player-search'
import { useAuth } from '@/hooks/use-auth'
import { STAT_COLUMN_SORT, type PlayerSearchSortMode } from '@/lib/player-search-sort'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { getMemberTransactionState } from '@/lib/league'
import { addLimitSummary } from '@/lib/pickup'
import { PlayerRow } from '@/lib/players'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadPlayerSupport } from '@/lib/player-availability'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import {
    debounceRealtimeRefresh,
    reportRealtimeCleanup,
    subscribeToTableChanges,
    unsubscribeFromTableChanges,
} from '@/lib/realtime'

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
const TABLE_COLUMNS = ['FP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP']
const STAT_LABELS: Record<string, string> = {
    FP: 'Fantasy points', PTS: 'Points', REB: 'Rebounds', AST: 'Assists', STL: 'Steals',
    BLK: 'Blocks', '3PM': 'Three-pointers made', TO: 'Turnovers', GP: 'Games played', MIN: 'Minutes',
}

const EMPTY_OWNED_MAP = new Map<string, OwnedEntry>()
const EMPTY_WAIVER_IDS = new Set<string>()

type TransactionState = Awaited<ReturnType<typeof getMemberTransactionState>> | null
type PlayerSupport = {
    leagueId: string | null
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    transactionState: TransactionState
}
type PlayerSupportCache = {
    ownedEntries: [string, OwnedEntry][]
    waiverIds: string[]
    transactionState: TransactionState
}
const SUPPORT_CACHE_PREFIX = 'pancake:player-support:v1:'
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
    const { memberships, current, currentLeague, loading: leagueLoading } = useLeagueContext()
    const { width } = useWindowDimensions()
    const leagueId = currentLeague?.id ?? null
    const searchEnabled = !!user && !!current?.id && !!leagueId
    const { compact: compactToolbar, padX } = usePageMetrics()
    const showStatTable = width >= 1180
    // Phones keep search on screen and move the filters into a sheet; wider
    // screens show every filter as a chip in one toolbar row.
    const [filtersOpen, setFiltersOpen] = useState(false)

    const cachedSupport = useMemo<PlayerSupport | undefined>(() => {
        if (!current?.id || !leagueId) return undefined
        const cached = readPersistentCache<PlayerSupportCache>(supportCacheKey(current.id, leagueId))
        if (!cached) return undefined
        return {
            leagueId,
            ownedMap: new Map(cached.ownedEntries),
            waiverIds: new Set(cached.waiverIds),
            transactionState: cached.transactionState,
        }
    }, [current?.id, leagueId])

    const {
        data: playerSupport,
        loading: playerSupportFetchLoading,
        error: playerSupportError,
        refresh: refreshPlayerSupport,
    } = useFocusAsyncData<PlayerSupport>(async () => {
        if (!leagueId) {
            return {
                leagueId: null,
                ownedMap: new Map<string, OwnedEntry>(),
                waiverIds: new Set<string>(),
                transactionState: null,
            }
        }
        const support = await loadPlayerSupport(current?.id, leagueId)
        if (current?.id) {
            writePersistentCache<PlayerSupportCache>(supportCacheKey(current.id, leagueId), {
                ownedEntries: Array.from(support.ownedMap.entries()),
                waiverIds: Array.from(support.waiverIds),
                transactionState: support.transactionState,
            })
        }
        return support
    }, [current?.id, leagueId], { initialData: cachedSupport, staleMs: 300_000 })

    useEffect(() => {
        if (!leagueId) return

        const refreshSupport = debounceRealtimeRefresh(() => { void refreshPlayerSupport() })
        const channel = subscribeToTableChanges(
            `players-screen:${leagueId}`,
            { mode: 'fallback', watches: [
                { table: 'roster_players', filter: `league_id=eq.${leagueId}` },
                { table: 'waiver_wire_log', filter: `league_id=eq.${leagueId}` },
                { table: 'waiver_claims', filter: `league_id=eq.${leagueId}` },
                { table: 'waiver_priorities', filter: `league_id=eq.${leagueId}` },
                { table: 'league_members', filter: `league_id=eq.${leagueId}` },
            ], onChange: refreshSupport.trigger },
        )

        return () => {
            refreshSupport.cancel()
            reportRealtimeCleanup('players', unsubscribeFromTableChanges(channel))
        }
    }, [leagueId, refreshPlayerSupport])

    const playerSupportForLeague = playerSupport?.leagueId === leagueId ? playerSupport : null
    const ownedMap = playerSupportForLeague?.ownedMap ?? EMPTY_OWNED_MAP
    const waiverIds = playerSupportForLeague?.waiverIds ?? EMPTY_WAIVER_IDS
    const playerSupportLoading = !!leagueId && playerSupportFetchLoading && playerSupportForLeague == null
    const playerSupportReady = !leagueId || playerSupportForLeague != null
    const transactionState = playerSupportForLeague?.transactionState ?? null

    const search = usePlayerSearch(leagueId, ownedMap, waiverIds, current?.id, { enabled: searchEnabled && playerSupportReady })
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
    const addBlockedReason = quickAdd.addBlockedReason
    const gamesLeftVersion = useMemo(() => Array.from(search.availability.gamesLeft.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([team, count]) => `${team}:${count}`)
        .join(','), [search.availability.gamesLeft])
    const { handleAdd: quickAddHandleAdd, handleClaim: quickAddHandleClaim } = quickAdd
    const handleAddPlayer = useCallback((player: PlayerRow) => {
        if (waiverIds.has(player.id)) void quickAddHandleClaim(player)
        else void quickAddHandleAdd(player)
    }, [waiverIds, quickAddHandleClaim, quickAddHandleAdd])
    const handleOpenPlayer = useCallback((player: PlayerRow) => {
        push(`/player/${player.id}`)
    }, [push])
    const renderPlayerItem = useCallback(({ item }: { item: PlayerRow }) => (
        <PlayerSearchItem
            item={item}
            currentMemberId={current?.id}
            ownedMap={ownedMap}
            waiverIds={waiverIds}
            isAdding={quickAdd.adding === item.id}
            gamesLeft={search.availability.gamesLeft}
            showStats={showStatTable}
            showCompactStats={false}
            animate={false}
            addBlockedReason={addBlockedReason}
            onAdd={handleAddPlayer}
            onPress={handleOpenPlayer}
        />
    ), [current?.id, ownedMap, waiverIds, quickAdd.adding, search.availability.gamesLeft, showStatTable, addBlockedReason, handleAddPlayer, handleOpenPlayer])
    const playerListExtraData = [
        search.sort.mode,
        search.sort.dir,
        search.availabilityFilter.value,
        search.playing.value,
        search.health.value,
        search.teamPicker.selectedTeams.join(','),
        gamesLeftVersion,
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
    const summaryLine = `${resultCountLabel} · ${addLimitSummary(transactionState)} · ${waiverLine}`
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
                        placeholderTextColor={colors.textPlaceholder}
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
                        listIsInitialLoading
                            ? null
                            : search.results.error
                              ? <EmptyState message="Players could not load." description={search.results.error.message} actionLabel="Retry" onAction={search.results.retry} fullScreen={false} />
                            : playerSupportError && playerSupportForLeague == null
                              ? <EmptyState message="Players could not load." description="Tap retry to reload roster and waiver state." actionLabel="Retry" onAction={() => void refreshPlayerSupport()} fullScreen={false} />
                            : search.activeFilterCount > 0
                              ? <EmptyState message="No players match these filters." actionLabel="Clear filters" onAction={search.clearAllFilters} fullScreen={false} />
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
                    <View style={[localStyles.panel, section !== 'players' && localStyles.hidden]}>
                        <PlayerSearchSection />
                    </View>
                ) : null}
                {/* Rankings and News share one instance, so each loads its data once. */}
                {opened.has('rankings') || opened.has('news') ? (
                    <View style={[localStyles.panel, section === 'players' && localStyles.hidden]}>
                        <DynastyHub section={section === 'news' || (section === 'players' && lastDynasty === 'news') ? 'news' : 'rankings'} />
                    </View>
                ) : null}
            </View>
        </Page>
    )
}

const localStyles = StyleSheet.create({
    panel: { flex: 1, minHeight: 0 },
    hidden: { display: 'none' },
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
