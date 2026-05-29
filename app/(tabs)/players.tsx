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
import { todayET } from '@/lib/shared/dates'
import { PlayerRow } from '@/lib/players'

const POSITIONS = ['ALL', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']
const TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS']

const EMPTY_OWNED_MAP = new Map<string, OwnedEntry>()
const EMPTY_WAIVER_IDS = new Set<string>()

export default function PlayersScreen() {
    const { push } = useRouter()
    const { current, currentLeague } = useLeagueContext()
    const leagueId = currentLeague?.id ?? null

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

    const search = usePlayerSearch(leagueId, ownedMap)
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
    const playerListOrderVersion = [search.sort.mode, search.sort.dir, gamesLeftVersion].join('|')

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.searchRow}>
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search players..."
                    placeholderTextColor={colors.textPlaceholder}
                    value={search.search.query}
                    onChangeText={search.search.setQuery}
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                />
                <Pressable
                    style={[styles.chip, search.toggles.availableOnly && styles.chipPrimary]}
                    onPress={() => search.toggles.setAvailableOnly((value) => !value)}
                >
                    <Text style={[styles.chipText, search.toggles.availableOnly && styles.chipTextActive]}>
                        Available
                    </Text>
                </Pressable>
                <Pressable
                    style={[styles.chip, search.toggles.rookiesOnly && styles.chipSuccess]}
                    onPress={() => search.toggles.setRookiesOnly((value) => !value)}
                >
                    <Text style={[styles.chipText, search.toggles.rookiesOnly && styles.chipTextActive]}>
                        Rookie
                    </Text>
                </Pressable>
            </View>

            <View style={styles.filterRow}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.positionScrollView}
                    contentContainerStyle={styles.positionChips}
                >
                    {POSITIONS.map((item) => (
                        <Pressable
                            key={item}
                            style={[styles.posChip, search.position.value === item && styles.posChipActive]}
                            onPress={() => search.position.setValue(item)}
                        >
                            <Text style={[styles.posChipText, search.position.value === item && styles.posChipTextActive]}>
                                {item}
                            </Text>
                        </Pressable>
                    ))}
                </ScrollView>

                <Pressable
                    ref={search.teamPicker.buttonRef}
                    style={[styles.teamDropdown, search.teamPicker.selectedTeams.length > 0 && styles.teamDropdownActive]}
                    onPress={search.teamPicker.open}
                >
                    <Text style={[styles.teamDropdownText, search.teamPicker.selectedTeams.length > 0 && styles.teamDropdownTextActive]}>
                        {search.teamPicker.selectedTeams.length === 0 ? 'Team'
                            : search.teamPicker.selectedTeams.length === 1 ? search.teamPicker.selectedTeams[0]
                            : `${search.teamPicker.selectedTeams.length} teams`}
                    </Text>
                    <Text style={[styles.teamDropdownCaret, search.teamPicker.selectedTeams.length > 0 && styles.teamDropdownTextActive]}>▾</Text>
                </Pressable>
            </View>

            <View style={styles.sortRow}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.sortChips}
                >
                    {SORT_OPTIONS.map((opt) => {
                        const active = search.sort.mode === opt.key
                        return (
                            <Pressable
                                key={opt.key}
                                style={[styles.sortChip, active && styles.sortChipActive]}
                                onPress={() => {
                                    if (active) {
                                        search.sort.setDir((dir) => dir === 'asc' ? 'desc' : 'asc')
                                    } else {
                                        search.sort.setMode(opt.key)
                                        search.sort.setDir(opt.key === 'name' || opt.key === 'team' ? 'asc' : 'desc')
                                    }
                                }}
                            >
                                <Text style={[styles.sortChipText, active && styles.sortChipTextActive]}>
                                    {opt.label}
                                    {active ? (search.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                                </Text>
                            </Pressable>
                        )
                    })}
                </ScrollView>
            </View>

            <View style={styles.dayFilterRow}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.dayChips}
                >
                    {search.availability.weekDays.filter((day) => day.date >= todayET()).map((day) => {
                        const active = search.availability.selectedDays.includes(day.date)
                        const label = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' })
                        return (
                            <Pressable
                                key={day.date}
                                style={[styles.dayChip, active && styles.dayChipActive]}
                                onPress={() => search.availability.toggleDay(day.date)}
                            >
                                <Text style={[styles.dayChipLabel, active && styles.dayChipTextActive]}>{label}</Text>
                                <Text style={[styles.dayChipNum, active && styles.dayChipTextActive]}>{day.dateNum}</Text>
                            </Pressable>
                        )
                    })}
                    {search.availability.selectedDays.length > 0 && (
                        <Pressable style={styles.dayClearBtn} onPress={() => search.availability.setSelectedDays([])}>
                            <Text style={styles.dayClearText}>Clear</Text>
                        </Pressable>
                    )}
                </ScrollView>
            </View>

            <View style={styles.filterStatusRow}>
                <Text style={styles.filterCountText}>
                    {search.results.loading ? 'Searching...' : `${search.results.players.length} player${search.results.players.length !== 1 ? 's' : ''}`}
                </Text>
                {search.activeFilterCount > 0 && (
                    <Pressable style={styles.clearAllChip} onPress={search.clearAllFilters}>
                        <Text style={styles.clearAllChipText}>Clear all ({search.activeFilterCount})</Text>
                    </Pressable>
                )}
            </View>

            <Modal
                visible={search.teamPicker.popover !== null}
                transparent
                animationType="none"
                onRequestClose={() => search.teamPicker.setPopover(null)}
            >
                <Pressable style={styles.popoverBackdrop} onPress={() => search.teamPicker.setPopover(null)}>
                    <View
                        style={[styles.teamPopover, search.teamPicker.popover ? { top: search.teamPicker.popover.top, right: search.teamPicker.popover.right } : {}]}
                        onStartShouldSetResponder={() => true}
                    >
                        {search.teamPicker.selectedTeams.length > 0 && (
                            <Pressable onPress={() => search.teamPicker.setSelectedTeams([])} style={styles.popoverClear}>
                                <Text style={styles.popoverClearText}>Clear</Text>
                            </Pressable>
                        )}
                        <View style={styles.teamGrid}>
                            {TEAMS.map((t) => {
                                const active = search.teamPicker.selectedTeams.includes(t)
                                return (
                                    <Pressable
                                        key={t}
                                        style={[styles.teamCell, active && styles.teamCellActive]}
                                        onPress={() => search.teamPicker.toggleTeam(t)}
                                    >
                                        <Text style={[styles.teamCellText, active && styles.teamCellTextActive]}>{t}</Text>
                                    </Pressable>
                                )
                            })}
                        </View>
                    </View>
                </Pressable>
            </Modal>

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
                    renderItem={({ item }: { item: PlayerRow }) => (
                        <PlayerSearchItem
                            item={item}
                            currentMemberId={current?.id}
                            ownedMap={ownedMap}
                            waiverIds={waiverIds}
                            adding={quickAdd.adding}
                            gamesLeft={search.availability.gamesLeft}
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

    searchRow: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    searchInput: {
        flex: 1,
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg + spacing.xxs,
        fontSize: fontSize.lg,
    },

    chip: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        flexShrink: 0,
    },
    chipPrimary: { backgroundColor: colors.primary },
    chipSuccess: { backgroundColor: colors.success },
    chipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    chipTextActive: { color: colors.textWhite },

    filterRow: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.xl, marginBottom: spacing.lg },
    positionScrollView: { flexGrow: 1, flexShrink: 1 },
    positionChips: { paddingLeft: spacing.xl, paddingRight: spacing.md, gap: spacing.md },
    teamDropdown: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        flexShrink: 0,
    },
    teamDropdownActive: { backgroundColor: colors.primary },
    teamDropdownText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamDropdownTextActive: { color: colors.textWhite },
    teamDropdownCaret: { fontSize: 11, color: colors.textSecondary },
    popoverBackdrop: { flex: 1 },
    teamPopover: {
        position: 'absolute',
        backgroundColor: colors.bgScreen,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous' as const,
        padding: spacing.md,
        ...(Platform.OS === 'web'
            ? { boxShadow: '0px 4px 12px rgba(0,0,0,0.18)' }
            : {
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.18,
                  shadowRadius: 12,
                  elevation: 8,
              }),
    },
    popoverClear: { alignItems: 'flex-end', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
    popoverClearText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
    teamGrid: { flexDirection: 'row', flexWrap: 'wrap', width: 6 * 44 },
    teamCell: {
        width: 44,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
    },
    teamCellActive: { backgroundColor: colors.primary },
    teamCellText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamCellTextActive: { color: colors.textWhite },
    posChip: {
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    posChipActive: { backgroundColor: colors.primary },
    posChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    posChipTextActive: { color: colors.textWhite },

    dayFilterRow: { marginBottom: spacing.md },
    dayChips: { paddingHorizontal: spacing.xl, gap: spacing.sm },
    dayChip: {
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        minWidth: 46,
    },
    dayChipActive: { backgroundColor: colors.primary },
    dayChipLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted, textTransform: 'uppercase' as const },
    dayChipNum: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    dayChipTextActive: { color: colors.textWhite },
    dayClearBtn: {
        alignSelf: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    dayClearText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primary },

    sortRow: { marginBottom: spacing.md },
    sortChips: { paddingHorizontal: spacing.xl, gap: spacing.sm },
    sortChip: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    sortChipActive: { backgroundColor: colors.primary },
    sortChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    sortChipTextActive: { color: colors.textWhite },

    filterStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.sm,
    },
    filterCountText: { fontSize: fontSize.sm, color: colors.textMuted },
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
