import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    useWindowDimensions,
    Animated,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { type OwnedEntry } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { NoLeagueState } from '@/components/NoLeagueState'
import { FilterSelect, MultiSelect } from '@/components/ui'
import { playerListStyles as styles } from '@/components/ui/playerListStyles'
import { NBA_TEAM_OPTIONS } from '@/constants/nba'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { usePlayerSearch, SORT_OPTIONS } from '@/hooks/use-player-search'
import { useAuth } from '@/hooks/use-auth'
import { STAT_COLUMN_SORT, type PlayerSearchSortMode } from '@/lib/player-search-sort'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { getMemberTransactionState } from '@/lib/league'
import { ADD_LIMIT_BLOCKED_TITLE, addLimitSummary } from '@/lib/add-limit'
import { PlayerRow } from '@/lib/players'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPlayerAvailabilitySnapshot } from '@/lib/player-availability'
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

export default function PlayersScreen() {
    const { push } = useRouter()
    const { user, loading: authLoading } = useAuth()
    const { memberships, current, currentLeague, loading: leagueLoading } = useLeagueContext()
    const { width } = useWindowDimensions()
    const leagueId = currentLeague?.id ?? null
    const searchEnabled = !!user && !!current?.id && !!leagueId
    const showStatTable = width >= 1180
    // On phones the full filter grid buries the results below the fold, so it
    // collapses behind a toggle; on wider screens it's always shown.
    const collapsibleFilters = width < 780
    const [filtersOpen, setFiltersOpen] = useState(false)
    const filtersVisible = !collapsibleFilters || filtersOpen

    const expandAnim = useRef(new Animated.Value(1)).current
    const [scrolledPastHeader, setScrolledPastHeader] = useState(false)
    const handleScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number } } }) => {
        setScrolledPastHeader(event.nativeEvent.contentOffset.y > 40)
    }, [])
    // Expanded whenever the user explicitly opened the filters — an open
    // toggle must never point at a collapsed (scroll-minimized) body.
    useEffect(() => {
        Animated.spring(expandAnim, {
            toValue: filtersOpen || !scrolledPastHeader ? 1 : 0,
            useNativeDriver: false,
            tension: 100,
            friction: 14,
        }).start()
    }, [expandAnim, filtersOpen, scrolledPastHeader])

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
        const [availability, transactionState] = await Promise.all([
            getPlayerAvailabilitySnapshot(leagueId),
            current?.id ? getMemberTransactionState(current.id, leagueId) : Promise.resolve(null),
        ])
        if (current?.id) {
            writePersistentCache<PlayerSupportCache>(supportCacheKey(current.id, leagueId), {
                ownedEntries: Array.from(availability.ownedMap.entries()),
                waiverIds: Array.from(availability.waiverIds),
                transactionState,
            })
        }
        return { ...availability, transactionState }
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
    const quickAdd = useQuickAdd({
        memberId: current?.id,
        leagueId,
        rosterSize: currentLeague?.roster_size ?? 20,
        waiverIds,
        refreshOwned: refreshPlayerSupport,
        refreshTransactionState: refreshPlayerSupport,
        transactionState,
    })
    const addBlockedReason = quickAdd.addBlockedReason
    const gamesLeftVersion = useMemo(() => Array.from(search.availability.gamesLeft.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([team, count]) => `${team}:${count}`)
        .join(','), [search.availability.gamesLeft])
    const quickAddHandleAdd = quickAdd.handleAdd
    const handleAddPlayer = useCallback((player: PlayerRow) => {
        if (waiverIds.has(player.id)) {
            push(`/(modals)/claim-player?playerId=${player.id}`)
        } else {
            void quickAddHandleAdd(player)
        }
    }, [waiverIds, push, quickAddHandleAdd])
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
    const listIsInitialLoading = playerSupportLoading || (search.results.loading && search.results.players.length === 0)

    // No placeholder shell while auth/league context loads — the screen stays
    // blank and the real UI appears fully formed, with no reflow.
    if (showInitialShell) {
        return <SafeAreaView style={styles.container} />
    }
    if (!user) return <NoLeagueState />
    if (memberships.length === 0 || !current || !leagueId) return <NoLeagueState />

    return (
        <SafeAreaView style={styles.container}>
          <View style={styles.contentWrap}>
            {/* Visually hidden h1: the screen has no visible title, but web
                a11y still needs a page heading anchoring the outline. */}
            <Text style={styles.hiddenHeading} role="heading" aria-level={1} accessibilityRole="header">
                Players
            </Text>
            <View style={[styles.filterCard, collapsibleFilters && localStyles.filterCardCompact, { gap: 0 }]}>
                <View style={styles.filterCardTop}>
                    <TextInput
                        style={styles.searchInput}
                        placeholder="Search players..."
                        placeholderTextColor={colors.textPlaceholder}
                        value={search.search.query}
                        onChangeText={search.search.setQuery}
                        autoCorrect={false}
                        clearButtonMode="while-editing"
                    />
                    {collapsibleFilters ? (
                        <Pressable
                            style={localStyles.filterToggleChip}
                            onPress={() => setFiltersOpen((v) => !v)}
                            accessibilityRole="button"
                            accessibilityLabel={`${filtersOpen ? 'Hide' : 'Show'} filters`}
                            accessibilityState={{ expanded: filtersOpen }}
                        >
                            <Text style={localStyles.filterToggleChipText}>Filters</Text>
                            {search.activeFilterCount > 0 ? (
                                <View style={styles.filterCountDot}>
                                    <Text style={styles.filterCountDotText}>{search.activeFilterCount}</Text>
                                </View>
                            ) : null}
                            <Text style={styles.filterSelectCaret}>{filtersOpen ? '▴' : '▾'}</Text>
                        </Pressable>
                    ) : (
                        <Text style={styles.resultCountText}>
                            {search.results.loading && search.results.players.length === 0
                                ? '— players'
                                : `${search.results.players.length}${search.activeFilterCount > 0 ? ' filtered' : ''} player${search.results.players.length === 1 ? '' : 's'}`}
                        </Text>
                    )}
                </View>
                <View style={localStyles.metaLine}>
                    <Text style={localStyles.metaLineText} numberOfLines={1}>
                        {collapsibleFilters
                            ? `${search.results.loading && search.results.players.length === 0 ? '—' : search.results.players.length}${search.activeFilterCount > 0 ? ' filtered' : ''} players · `
                            : ''}
                        {addLimitSummary(transactionState)}
                        {' · '}
                        {transactionState
                            ? transactionState.waiverMode === 'faab'
                                ? `FAAB $${transactionState.faabBalance}`
                                : 'Rolling waivers'
                            : 'Waivers —'}
                    </Text>
                    {addBlockedReason ? (
                        <Text
                            style={localStyles.addLimitNotice}
                            accessibilityLiveRegion="polite"
                            role="status"
                            testID="add-limit-notice"
                        >
                            {ADD_LIMIT_BLOCKED_TITLE}. {addBlockedReason}
                        </Text>
                    ) : null}
                </View>
                <Animated.View style={{
                    overflow: 'hidden',
                    maxHeight: expandAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 600] }),
                    opacity: expandAnim,
                }}>
                    {!filtersVisible && search.activeFilterCount === 0 ? null : (
                    <View style={{ gap: spacing.lg, paddingTop: spacing.lg }}>
                        {!collapsibleFilters || search.activeFilterCount > 0 ? (
                            <View style={styles.filterCardHeader}>
                                {!collapsibleFilters ? (
                                    <Text style={styles.filterCardTitle} role="heading" aria-level={2}>Filters</Text>
                                ) : <View />}
                                {search.activeFilterCount > 0 ? (
                                    <Pressable style={styles.clearAllChip} onPress={search.clearAllFilters}>
                                        <Text style={styles.clearAllChipText}>Clear all ({search.activeFilterCount})</Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        ) : null}
                        {filtersVisible ? (
                        <View style={styles.filterGrid}>
                            <FilterSelect
                                label="Availability"
                                value={search.availabilityFilter.value}
                                options={AVAILABILITY_FILTERS}
                                onChange={search.availabilityFilter.setValue}
                            />
                            <FilterSelect
                                label="Position"
                                value={search.position.value}
                                options={POSITIONS}
                                onChange={search.position.setValue}
                            />
                            <MultiSelect
                                label="Pro team"
                                options={NBA_TEAM_OPTIONS}
                                selected={search.teamPicker.selectedTeams}
                                onChange={search.teamPicker.setSelectedTeams}
                                pluralLabel="teams"
                                clearAccessibilityLabel="Clear teams"
                            />
                            <FilterSelect
                                label="Health"
                                value={search.health.value}
                                options={HEALTH_FILTERS}
                                onChange={search.health.setValue}
                            />
                            <FilterSelect
                                label="Game today"
                                value={search.playing.value}
                                options={PLAYING_FILTERS}
                                onChange={search.playing.setValue}
                            />
                            <FilterSelect
                                label="Experience"
                                value={search.toggles.rookiesOnly ? 'rookies' : 'all'}
                                options={CLASS_FILTERS}
                                onChange={(value) => search.toggles.setRookiesOnly(value === 'rookies')}
                            />
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
                                style={styles.sortDirButton}
                                onPress={() => search.sort.setDir((dir) => dir === 'asc' ? 'desc' : 'asc')}
                            >
                                <Text style={styles.sortDirText}>{search.sort.dir === 'asc' ? 'Ascending ↑' : 'Descending ↓'}</Text>
                            </Pressable>
                        </View>
                        ) : null}
                    </View>
                    )}
                </Animated.View>
            </View>

            <FlashList
                    ref={search.results.listRef}
                    data={search.results.players}
                    onScroll={handleScroll}
                    scrollEventThrottle={16}
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
        </SafeAreaView>
    )
}

const localStyles = StyleSheet.create({
    filterCardCompact: {
        marginTop: spacing.md,
        marginHorizontal: spacing.sm,
        marginBottom: spacing.md,
        padding: spacing.lg,
    },
    filterToggleChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgMuted,
    },
    filterToggleChipText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    metaLine: {
        paddingTop: spacing.sm,
    },
    metaLineText: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
    },
    addLimitNotice: {
        marginTop: spacing.xs,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: colors.warningDark,
    },
})

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
