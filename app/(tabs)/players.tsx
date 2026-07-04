import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    Modal,
    ScrollView,
    Platform,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { type OwnedEntry } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, fontSize, fontWeight, radii, spacing, srOnly, layout } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { NoLeagueState } from '@/components/NoLeagueState'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { usePlayerSearch, SORT_OPTIONS } from '@/hooks/use-player-search'
import { useAuth } from '@/hooks/use-auth'
import { STAT_COLUMN_SORT, type PlayerSearchSortMode } from '@/lib/player-search-sort'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { getMemberTransactionState } from '@/lib/league'
import { PlayerRow } from '@/lib/players'
import { useState } from 'react'
import { getPlayerAvailabilitySnapshot } from '@/lib/player-availability'

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
const TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS']
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
const TABLE_COLUMNS = ['FP', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP']
const STAT_LABELS: Record<string, string> = {
    FP: 'Fantasy points', PTS: 'Points', REB: 'Rebounds', AST: 'Assists', STL: 'Steals',
    BLK: 'Blocks', '3PM': 'Three-pointers made', TO: 'Turnovers', GP: 'Games played',
}

const EMPTY_OWNED_MAP = new Map<string, OwnedEntry>()
const EMPTY_WAIVER_IDS = new Set<string>()

type FilterOption<T extends string> = { key: T; label: string }

function FilterSelect<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string
    value: T
    options: readonly FilterOption<T>[]
    onChange: (value: T) => void
}) {
    const [open, setOpen] = useState(false)
    const current = options.find((option) => option.key === value) ?? options[0]

    return (
        <View style={styles.filterSelectWrap}>
            <Text style={styles.filterSelectLabel}>{label}</Text>
            <Pressable
                style={styles.filterSelectButton}
                onPress={() => setOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${current.label}`}
            >
                <Text style={styles.filterSelectValue} numberOfLines={1}>{current.label}</Text>
                <Text style={styles.filterSelectCaret}>▾</Text>
            </Pressable>
            <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
                <Pressable style={styles.selectBackdrop} onPress={() => setOpen(false)}>
                    <View style={styles.selectSheet} onStartShouldSetResponder={() => true}>
                        <Text style={styles.selectTitle}>{label}</Text>
                        <ScrollView>
                            {options.map((option) => {
                                const active = option.key === value
                                return (
                                    <Pressable
                                        key={option.key}
                                        style={[styles.selectOption, active && styles.selectOptionActive]}
                                        onPress={() => {
                                            onChange(option.key)
                                            setOpen(false)
                                        }}
                                    >
                                        <Text style={[styles.selectOptionText, active && styles.selectOptionTextActive]}>
                                            {option.label}
                                        </Text>
                                    </Pressable>
                                )
                            })}
                        </ScrollView>
                    </View>
                </Pressable>
            </Modal>
        </View>
    )
}

function MultiTeamSelect({
    label,
    selected,
    onChange,
}: {
    label: string
    selected: string[]
    onChange: (teams: string[]) => void
}) {
    const [open, setOpen] = useState(false)
    const summary = selected.length === 0 ? 'All' : selected.length === 1 ? selected[0] : `${selected.length} teams`
    const toggle = (team: string) =>
        onChange(selected.includes(team) ? selected.filter((t) => t !== team) : [...selected, team])

    return (
        <View style={styles.filterSelectWrap}>
            <Text style={styles.filterSelectLabel}>{label}</Text>
            <Pressable
                style={styles.filterSelectButton}
                onPress={() => setOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${summary}`}
            >
                <Text style={styles.filterSelectValue} numberOfLines={1}>{summary}</Text>
                <Text style={styles.filterSelectCaret}>▾</Text>
            </Pressable>
            <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
                <Pressable style={styles.selectBackdrop} onPress={() => setOpen(false)}>
                    <View style={styles.selectSheet} onStartShouldSetResponder={() => true}>
                        <View style={styles.multiHeader}>
                            <Text style={styles.selectTitle}>{label}</Text>
                            {selected.length > 0 ? (
                                <Pressable onPress={() => onChange([])} accessibilityRole="button" accessibilityLabel="Clear teams">
                                    <Text style={styles.multiClear}>Clear</Text>
                                </Pressable>
                            ) : null}
                        </View>
                        <ScrollView>
                            <View style={styles.teamGrid}>
                                {TEAMS.map((team) => {
                                    const active = selected.includes(team)
                                    return (
                                        <Pressable
                                            key={team}
                                            style={[styles.teamChip, active && styles.teamChipActive]}
                                            onPress={() => toggle(team)}
                                            accessibilityRole="checkbox"
                                            accessibilityState={{ checked: active }}
                                            accessibilityLabel={team}
                                        >
                                            <Text style={[styles.teamChipText, active && styles.teamChipTextActive]}>{team}</Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </ScrollView>
                        <Pressable style={styles.multiDone} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Done">
                            <Text style={styles.multiDoneText}>Done</Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Modal>
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

    const {
        data: ownedData,
        loading: ownedLoading,
        error: ownedError,
        refresh: refreshOwned,
    } = useFocusAsyncData(async () => {
        if (!leagueId) return { leagueId: null, ownedMap: new Map<string, OwnedEntry>(), waiverIds: new Set<string>() }
        return getPlayerAvailabilitySnapshot(leagueId)
    }, [leagueId])

    const ownedDataForLeague = ownedData?.leagueId === leagueId ? ownedData : null
    const ownedMap = ownedDataForLeague?.ownedMap ?? EMPTY_OWNED_MAP
    const waiverIds = ownedDataForLeague?.waiverIds ?? EMPTY_WAIVER_IDS
    const playerSupportLoading = !!leagueId && ownedLoading && ownedDataForLeague == null
    const playerSupportReady = !leagueId || ownedDataForLeague != null

    const {
        data: transactionState,
        refresh: refreshTransactionState,
    } = useFocusAsyncData(async () => {
        if (!current?.id || !leagueId) return null
        return getMemberTransactionState(current.id, leagueId)
    }, [current?.id, leagueId])

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
    const quickAdd = useQuickAdd(
        current?.id,
        leagueId,
        currentLeague?.roster_size ?? 20,
        waiverIds,
        refreshOwned,
        refreshTransactionState,
    )
    const gamesLeftVersion = Array.from(search.availability.gamesLeft.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([team, count]) => `${team}:${count}`)
        .join(',')
    const playerListExtraData = [
        search.sort.mode,
        search.sort.dir,
        search.availabilityFilter.value,
        search.playing.value,
        search.health.value,
        search.teamPicker.selectedTeams.join(','),
        gamesLeftVersion,
    ].join('|')

    if (authLoading || !user) return <NoLeagueState />
    if (leagueLoading && memberships.length === 0) return <NoLeagueState />
    if (memberships.length === 0 || !current || !leagueId) return <NoLeagueState />

    return (
        <SafeAreaView style={styles.container}>
          <View style={styles.contentWrap}>
            {/* Visually hidden h1: the screen has no visible title, but web
                a11y still needs a page heading anchoring the outline. */}
            <Text style={styles.hiddenHeading} role="heading" aria-level={1} accessibilityRole="header">
                Players
            </Text>
            <View style={styles.filterCard}>
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
                    <Text style={styles.resultCountText}>
                        {search.results.loading && search.results.players.length === 0
                            ? 'Players'
                            : `${search.results.players.length}${search.activeFilterCount > 0 ? ' filtered' : ''} player${search.results.players.length === 1 ? '' : 's'}`}
                    </Text>
                </View>
                <View style={styles.filterCardHeader}>
                    {collapsibleFilters ? (
                        <Pressable
                            style={styles.filterToggle}
                            onPress={() => setFiltersOpen((v) => !v)}
                            accessibilityRole="button"
                            accessibilityLabel={`${filtersOpen ? 'Hide' : 'Show'} filters`}
                            accessibilityState={{ expanded: filtersOpen }}
                        >
                            <Text style={styles.filterCardTitle}>Filters</Text>
                            {search.activeFilterCount > 0 ? (
                                <View style={styles.filterCountDot}>
                                    <Text style={styles.filterCountDotText}>{search.activeFilterCount}</Text>
                                </View>
                            ) : null}
                            <Text style={styles.filterSelectCaret}>{filtersOpen ? '▴' : '▾'}</Text>
                        </Pressable>
                    ) : (
                        <Text style={styles.filterCardTitle} role="heading" aria-level={2}>Filters</Text>
                    )}
                    {search.activeFilterCount > 0 ? (
                        <Pressable style={styles.clearAllChip} onPress={search.clearAllFilters}>
                            <Text style={styles.clearAllChipText}>Clear all ({search.activeFilterCount})</Text>
                        </Pressable>
                    ) : null}
                </View>
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
                    <MultiTeamSelect
                        label="Pro team"
                        selected={search.teamPicker.selectedTeams}
                        onChange={search.teamPicker.setSelectedTeams}
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
                {transactionState ? (
                    <View style={styles.transactionBar}>
                        <Text style={styles.transactionBarText}>
                            Adds: {transactionState.weeklyAddCount}/{transactionState.weeklyAddLimit ?? 'Unlimited'} this week
                        </Text>
                        <Text style={styles.transactionBarText}>
                            {transactionState.waiverMode === 'faab'
                                ? `FAAB: $${transactionState.faabBalance}`
                                : 'Waivers: rolling priority'}
                        </Text>
                    </View>
                ) : null}
            </View>

            <FlashList
                    ref={search.results.listRef}
                    data={search.results.players}
                    extraData={playerListExtraData}
                    keyExtractor={(p: PlayerRow) => p.id}
                    contentContainerStyle={search.results.players.length === 0 ? styles.emptyContainer : undefined}
                    ItemSeparatorComponent={ItemSeparator}
                    ListHeaderComponent={showStatTable ? (
                        <View style={styles.tableHeader}>
                            <View style={styles.tableHeaderAddSpacer} />
                            <View style={styles.tableHeaderCardRow}>
                                <View style={styles.tableHeaderHeadshotSpacer} />
                                <Text style={styles.tableHeaderPlayer}>Player</Text>
                                <Text style={styles.tableHeaderOwnership}>Ownership</Text>
                                <View style={styles.tableHeaderStatsGroup}>
                                    {TABLE_COLUMNS.map((column) => {
                                        const mode = STAT_COLUMN_SORT[column]
                                        const active = mode != null && search.sort.mode === mode
                                        return (
                                            <Pressable
                                                key={column}
                                                style={styles.tableHeaderStatBtn}
                                                onPress={() => mode && handleColumnSort(mode)}
                                                accessibilityRole="button"
                                                accessibilityState={{ selected: active }}
                                                accessibilityLabel={`Sort by ${STAT_LABELS[column] ?? column}${active ? (search.sort.dir === 'asc' ? ', ascending' : ', descending') : ''}`}
                                            >
                                                <Text style={[styles.tableHeaderStat, active && styles.tableHeaderStatActive]} numberOfLines={1}>
                                                    {column}{active ? (search.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                                                </Text>
                                            </Pressable>
                                        )
                                    })}
                                </View>
                            </View>
                        </View>
                    ) : null}
                    renderItem={({ item }: { item: PlayerRow }) => (
                        <PlayerSearchItem
                            item={item}
                            currentMemberId={current?.id}
                            ownedMap={ownedMap}
                            waiverIds={waiverIds}
                            adding={quickAdd.adding}
                            gamesLeft={search.availability.gamesLeft}
                            showStats={showStatTable}
                            showCompactStats={false}
                            animate={false}
                            onAdd={(player) => {
                                if (waiverIds.has(player.id)) {
                                    push(`/(modals)/claim-player?playerId=${player.id}`)
                                } else {
                                    void quickAdd.handleAdd(player)
                                }
                            }}
                            onPress={() => push(`/player/${item.id}`)}
                        />
                    )}
                    ListEmptyComponent={
                        playerSupportLoading || search.results.loading
                            ? null
                            : ownedError && ownedDataForLeague == null
                              ? <EmptyState message="Players could not load." description="Tap retry to reload roster and waiver state." actionLabel="Retry" onAction={() => void refreshOwned()} fullScreen={false} />
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

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    contentWrap: { flex: 1, width: '100%', maxWidth: layout.contentMaxWidth, alignSelf: 'center' },
    hiddenHeading: {
        ...srOnly,
    },
    flex1: { flex: 1 },
    loadMoreSpinner: { paddingVertical: 16 },
    filterCard: {
        margin: spacing.xl,
        marginBottom: spacing.md,
        padding: spacing.lg,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        backgroundColor: colors.bgCard,
        gap: spacing.lg,
        ...(Platform.OS === 'web' ? { boxShadow: '0 10px 28px rgba(74, 37, 9, 0.08)' } : {}),
    },
    filterCardTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    filterCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
    },
    filterCardTitle: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
    },
    filterToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 32,
    },
    filterCountDot: {
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: radii.full,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    filterCountDotText: { fontSize: 11, fontWeight: fontWeight.bold, color: colors.textWhite },
    resultCountText: {
        flexShrink: 0,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
    },
    filterGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md,
    },
    filterSelectWrap: {
        minWidth: 142,
        flexGrow: 1,
        flexBasis: 142,
        gap: spacing.xs,
    },
    filterSelectLabel: {
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    filterSelectButton: {
        minHeight: 38,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.md,
    },
    filterSelectValue: {
        flex: 1,
        minWidth: 0,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    filterSelectCaret: {
        flexShrink: 0,
        fontSize: 11,
        color: colors.textMuted,
    },
    selectBackdrop: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.xl,
        backgroundColor: 'rgba(44, 26, 14, 0.36)',
    },
    selectSheet: {
        width: '100%',
        maxWidth: 360,
        maxHeight: 460,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.lg,
        backgroundColor: colors.bgCard,
        padding: spacing.md,
        ...(Platform.OS === 'web' ? { boxShadow: '0 18px 48px rgba(0,0,0,0.22)' } : {}),
    },
    selectTitle: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        fontSize: fontSize.md,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    multiHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    multiClear: {
        paddingHorizontal: spacing.sm,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.danger,
    },
    teamGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        padding: spacing.sm,
    },
    teamChip: {
        minWidth: 52,
        minHeight: 36,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgMuted,
    },
    teamChipActive: {
        backgroundColor: colors.primaryLight,
        borderColor: colors.primaryBorder,
    },
    teamChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    teamChipTextActive: { color: colors.primaryDark },
    multiDone: {
        marginTop: spacing.sm,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.primary,
    },
    multiDoneText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textWhite },
    selectOption: {
        minHeight: 42,
        justifyContent: 'center',
        borderRadius: radii.md,
        paddingHorizontal: spacing.md,
    },
    selectOptionActive: {
        backgroundColor: colors.primaryLight,
    },
    selectOptionText: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    selectOptionTextActive: {
        color: colors.primaryDark,
    },
    sortDirButton: {
        minHeight: 38,
        alignSelf: 'flex-end',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.lg,
    },
    sortDirText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    transactionBar: {
        minHeight: 36,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        paddingTop: spacing.md,
    },
    transactionBarText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    tableHeader: {
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.lg,    // mirrors playerRow.paddingLeft
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    tableHeaderAddSpacer: { width: 36 },    // mirrors addCol.width
    tableHeaderCardRow: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.md,    // mirrors playerCard.paddingLeft
        paddingRight: spacing['4xl'], // mirrors playerCard.paddingRight
        gap: spacing.lg,            // mirrors playerCard.gap
    },
    tableHeaderHeadshotSpacer: { width: 44 },  // mirrors headshot.width
    tableHeaderPlayer: {
        flex: 1,                    // mirrors playerInfo flex: 1
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    tableHeaderOwnership: {
        width: 90,                  // mirrors statusBadge.width
        textAlign: 'center',
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.7,
        textTransform: 'uppercase' as const,
    },
    tableHeaderStatsGroup: {
        width: 9 * 54,              // mirrors statsGrid.width
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end', // mirrors statsGrid.justifyContent
    },
    tableHeaderStatBtn: {
        width: 54,                  // mirrors statCell.width
        minHeight: 34,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    tableHeaderStat: {
        textAlign: 'right',
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textSecondary,
        letterSpacing: 0.7,
        textTransform: 'uppercase' as const,
    },
    tableHeaderStatActive: {
        color: colors.primaryDark,
    },

    searchInput: {
        flex: 1,
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg + spacing.xxs,
        fontSize: fontSize.lg,
        color: colors.textPrimary,
    },
    clearAllChip: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.dangerLight,
    },
    clearAllChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.danger },

    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
})
