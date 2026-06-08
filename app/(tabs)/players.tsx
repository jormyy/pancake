import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Modal,
    ScrollView,
    Platform,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { getOwnedPlayerMap, OwnedEntry } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { PlayerSearchItem } from '@/components/PlayerSearchItem'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { usePlayerSearch, SORT_OPTIONS } from '@/hooks/use-player-search'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { getWaiverPlayerIds } from '@/lib/waivers'
import { PlayerRow } from '@/lib/players'
import { useState } from 'react'

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
    { key: 'all', label: 'All classes' },
    { key: 'rookies', label: 'Rookies' },
] as const
const TABLE_COLUMNS = ['FP', 'PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'GP']

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

export default function PlayersScreen() {
    const { push } = useRouter()
    const { current, currentLeague } = useLeagueContext()
    const { width } = useWindowDimensions()
    const leagueId = currentLeague?.id ?? null
    const showStatTable = width >= 1180

    const {
        data: ownedData,
        refresh: refreshOwned,
    } = useFocusAsyncData(async () => {
        if (!leagueId) return { ownedMap: new Map<string, OwnedEntry>(), waiverIds: new Set<string>() }
        const [om, wIds] = await Promise.all([
            getOwnedPlayerMap(leagueId),
            getWaiverPlayerIds(leagueId),
        ])
        return { ownedMap: om, waiverIds: wIds }
    }, [leagueId])

    const ownedMap = ownedData?.ownedMap ?? EMPTY_OWNED_MAP
    const waiverIds = ownedData?.waiverIds ?? EMPTY_WAIVER_IDS

    const search = usePlayerSearch(leagueId, ownedMap, waiverIds, current?.id)
    const quickAdd = useQuickAdd(
        current?.id,
        leagueId,
        currentLeague?.roster_size ?? 20,
        waiverIds,
        refreshOwned,
    )
    const gamesLeftVersion = Array.from(search.availability.gamesLeft.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([team, count]) => `${team}:${count}`)
        .join(',')
    const playerListOrderVersion = [
        search.sort.mode,
        search.sort.dir,
        search.availabilityFilter.value,
        search.playing.value,
        search.health.value,
        search.teamPicker.selectedTeams.join(','),
        gamesLeftVersion,
    ].join('|')
    const teamValue = search.teamPicker.selectedTeams[0] ?? 'ALL'

    return (
        <SafeAreaView style={styles.container}>
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
                        {search.results.loading ? 'Searching...' : `${search.results.players.length} players`}
                    </Text>
                </View>
                <View style={styles.filterCardHeader}>
                    <Text style={styles.filterCardTitle}>Filters</Text>
                    {search.activeFilterCount > 0 ? (
                        <Pressable style={styles.clearAllChip} onPress={search.clearAllFilters}>
                            <Text style={styles.clearAllChipText}>Clear all ({search.activeFilterCount})</Text>
                        </Pressable>
                    ) : null}
                </View>
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
                    <FilterSelect
                        label="Pro team"
                        value={teamValue}
                        options={[{ key: 'ALL', label: 'All' }, ...TEAMS.map((team) => ({ key: team, label: team }))] as const}
                        onChange={(value) => search.teamPicker.setSelectedTeams(value === 'ALL' ? [] : [value])}
                    />
                    <FilterSelect
                        label="Health"
                        value={search.health.value}
                        options={HEALTH_FILTERS}
                        onChange={search.health.setValue}
                    />
                    <FilterSelect
                        label="Playing"
                        value={search.playing.value}
                        options={PLAYING_FILTERS}
                        onChange={search.playing.setValue}
                    />
                    <FilterSelect
                        label="Class"
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
                            search.sort.setDir(value === 'name' || value === 'team' ? 'asc' : 'desc')
                        }}
                    />
                    <Pressable
                        style={styles.sortDirButton}
                        onPress={() => search.sort.setDir((dir) => dir === 'asc' ? 'desc' : 'asc')}
                    >
                        <Text style={styles.sortDirText}>{search.sort.dir === 'asc' ? 'Ascending ↑' : 'Descending ↓'}</Text>
                    </Pressable>
                </View>
            </View>

            {search.results.loading ? (
                <ActivityIndicator style={styles.flex1} color={colors.primary} />
            ) : (
                <FlashList
                    key={playerListOrderVersion}
                    ref={search.results.listRef}
                    data={search.results.players}
                    extraData={playerListOrderVersion}
                    keyExtractor={(p: PlayerRow) => p.id}
                    contentContainerStyle={search.results.players.length === 0 ? styles.emptyContainer : undefined}
                    ItemSeparatorComponent={ItemSeparator}
                    ListHeaderComponent={showStatTable ? (
                        <View style={styles.tableHeader}>
                            <Text style={styles.tableHeaderPlayer}>Player</Text>
                            {TABLE_COLUMNS.map((column) => (
                                <Text key={column} style={styles.tableHeaderStat}>{column}</Text>
                            ))}
                            <Text style={styles.tableHeaderStatus}>Status</Text>
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
                            onAdd={quickAdd.handleAdd}
                            onPress={() => push(`/player/${item.id}`)}
                        />
                    )}
                    ListEmptyComponent={<EmptyState message="No players found." fullScreen={false} />}
                    onEndReached={search.results.loadMore}
                    onEndReachedThreshold={0.3}
                    ListFooterComponent={search.results.loadingMore ? <ActivityIndicator style={styles.loadMoreSpinner} color={colors.primary} /> : null}
                />
            )}

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
        color: colors.primary,
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
    tableHeader: {
        minHeight: 34,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
    },
    tableHeaderPlayer: {
        width: 36 + 420,
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    tableHeaderStat: {
        width: 54,
        textAlign: 'right',
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.7,
    },
    tableHeaderStatus: {
        width: 90,
        textAlign: 'right',
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.7,
        textTransform: 'uppercase' as const,
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
