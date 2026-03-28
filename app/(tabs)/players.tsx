import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
    Modal,
    ScrollView,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useState, useEffect, useCallback } from 'react'
import { searchPlayers, PlayerRow } from '@/lib/players'
import {
    getOwnedPlayerMap,
    addFreeAgent,
    dropPlayer,
    getRoster,
    RosterPlayer,
    OwnedEntry,
} from '@/lib/roster'
import { getWaiverPlayerIds, submitWaiverClaim } from '@/lib/waivers'
import { useLeagueContext } from '@/contexts/league-context'
import { POSITION_COLORS } from '@/constants/positions'
import {
    INJURY_COLORS,
    colors,
    palette,
    fontSize,
    fontWeight,
    radii,
    spacing,
} from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { EmptyState } from '@/components/EmptyState'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'

const POSITIONS = ['ALL', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']

// ── Extracted list item component ────────────────────────────────

function PlayerSearchItem({
    item,
    currentMemberId,
    ownedMap,
    waiverIds,
    adding,
    onAdd,
    onPress,
}: {
    item: PlayerRow
    currentMemberId: string | undefined
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    adding: string | null
    onAdd: (player: PlayerRow) => void
    onPress: () => void
}) {
    const owned = ownedMap.get(item.id)
    const isMe = owned?.memberId === currentMemberId
    const isOther = owned && !isMe
    const isWaiver = !owned && waiverIds.has(item.id)
    const isFA = !owned && !isWaiver
    const canAdd = currentMemberId && (isFA || isWaiver)
    const isAdding = adding === item.id

    return (
        <View style={styles.playerRow}>
            {/* Plus button */}
            <View style={styles.addCol}>
                {canAdd ? (
                    <Pressable
                        style={styles.addBtn}
                        onPress={() => onAdd(item)}
                        disabled={isAdding}
                    >
                        {isAdding
                            ? <ActivityIndicator size="small" color={colors.primary} />
                            : <Text style={styles.addBtnText}>+</Text>}
                    </Pressable>
                ) : null}
            </View>

            {/* Player card (tappable → detail) */}
            <Pressable style={styles.playerCard} onPress={onPress}>
                <Avatar
                    name={item.display_name}
                    color={POSITION_COLORS[item.position ?? ''] ?? palette.gray500}
                />

                <View style={styles.playerInfo}>
                    <Text style={styles.playerName}>{item.display_name}</Text>
                    <Text style={styles.playerMeta}>
                        {[item.nba_team, item.position].filter(Boolean).join(' · ')}
                    </Text>
                </View>

                {/* Injury badge */}
                {item.injury_status ? (
                    <Badge
                        label={item.injury_status}
                        color={INJURY_COLORS[item.injury_status] ?? colors.textMuted}
                        variant="solid"
                    />
                ) : null}

                {/* Status badge */}
                {currentMemberId ? (
                    <View style={[
                        styles.statusBadge,
                        isMe && styles.statusBadgeMe,
                        isWaiver && styles.statusBadgeWaiver,
                        isFA && styles.statusBadgeFA,
                    ]}>
                        <Text
                            style={[
                                styles.statusBadgeText,
                                isMe && styles.statusBadgeTextMe,
                                isWaiver && styles.statusBadgeTextWaiver,
                            ]}
                            numberOfLines={1}
                        >
                            {isMe ? 'Mine'
                                : isOther ? owned!.teamName
                                : isWaiver ? 'W'
                                : 'FA'}
                        </Text>
                    </View>
                ) : null}
            </Pressable>
        </View>
    )
}

// ── Main screen ──────────────────────────────────────────────────

export default function PlayersScreen() {
    const { push } = useRouter()
    const { current } = useLeagueContext()
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [players, setPlayers] = useState<PlayerRow[]>([])
    const [loading, setLoading] = useState(true)

    // Quick-add state
    const [adding, setAdding] = useState<string | null>(null)
    const [dropPickerPlayer, setDropPickerPlayer] = useState<PlayerRow | null>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [dropping, setDropping] = useState<string | null>(null)

    const leagueId = current ? (current.leagues as any).id : null

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

    const ownedMap = ownedData?.ownedMap ?? new Map<string, OwnedEntry>()
    const waiverIds = ownedData?.waiverIds ?? new Set<string>()

    const load = useCallback(async (q: string, pos: string) => {
        setLoading(true)
        try {
            setPlayers(await searchPlayers(q, pos))
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        const timer = setTimeout(() => load(query, position), 300)
        return () => clearTimeout(timer)
    }, [query, position, load])

    async function handleAdd(player: PlayerRow) {
        if (!current) return
        const league = current.leagues as any

        if (waiverIds.has(player.id)) {
            Alert.alert(
                'Place Waiver Claim',
                `You sure you wanna put in a waiver claim for ${player.display_name}? Claims process nightly.`,
                [
                    { text: 'Nah', style: 'cancel' },
                    {
                        text: 'Claim',
                        onPress: async () => {
                            setAdding(player.id)
                            try {
                                await submitWaiverClaim(current.id, league.id, player.id)
                                await refreshOwned()
                            } catch (e: any) {
                                Alert.alert('Error', e.message)
                            } finally {
                                setAdding(null)
                            }
                        },
                    },
                ],
            )
            return
        }

        // Free agent — try immediate add
        setAdding(player.id)
        try {
            await addFreeAgent(current.id, league.id, player.id)
            await refreshOwned()
        } catch (e: any) {
            if (e.message?.includes('full')) {
                const roster = await getRoster(current.id, league.id)
                setMyRoster(roster.filter((r) => !r.is_on_ir))
                setDropPickerPlayer(player)
            } else {
                Alert.alert('Error', e.message)
            }
        } finally {
            setAdding(null)
        }
    }

    async function handleDropAndAdd(rosterPlayer: RosterPlayer) {
        if (!current || !dropPickerPlayer) return
        const league = current.leagues as any
        setDropping(rosterPlayer.id)
        try {
            await dropPlayer(rosterPlayer.id)
            await addFreeAgent(current.id, league.id, dropPickerPlayer.id)
            setDropPickerPlayer(null)
            await refreshOwned()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDropping(null)
        }
    }

    return (
        <SafeAreaView style={styles.container}>
            {/* Search bar */}
            <View style={styles.searchRow}>
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search players..."
                    placeholderTextColor={colors.textPlaceholder}
                    value={query}
                    onChangeText={setQuery}
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                />
            </View>

            {/* Position filter */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.positionScrollView}
                contentContainerStyle={styles.positionRow}
            >
                {POSITIONS.map((item) => (
                    <Pressable
                        key={item}
                        style={[styles.posChip, position === item && styles.posChipActive]}
                        onPress={() => setPosition(item)}
                    >
                        <Text style={[styles.posChipText, position === item && styles.posChipTextActive]}>
                            {item}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>

            {/* Results */}
            {loading ? (
                <ActivityIndicator style={styles.flex1} color={colors.primary} />
            ) : (
                <FlashList
                    data={players}
                    keyExtractor={(p) => p.id}
                    contentContainerStyle={players.length === 0 ? styles.emptyContainer : undefined}
                    ItemSeparatorComponent={ItemSeparator}
                    renderItem={({ item }) => (
                        <PlayerSearchItem
                            item={item}
                            currentMemberId={current?.id}
                            ownedMap={ownedMap}
                            waiverIds={waiverIds}
                            adding={adding}
                            onAdd={handleAdd}
                            onPress={() => push(`/player/${item.id}`)}
                        />
                    )}
                    ListEmptyComponent={<EmptyState message="No players found." fullScreen={false} />}
                />
            )}

            {/* Drop picker modal */}
            <Modal
                visible={dropPickerPlayer !== null}
                transparent
                animationType="slide"
                onRequestClose={() => setDropPickerPlayer(null)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalCard}>
                        <Text style={styles.modalTitle}>
                            Drop a player to add{'\n'}
                            <Text style={styles.modalPlayerName}>{dropPickerPlayer?.display_name}</Text>
                        </Text>
                        <Text style={styles.modalSub}>Your roster is full. Pick someone to release.</Text>

                        <ScrollView style={styles.dropList} showsVerticalScrollIndicator={false}>
                            {myRoster.map((rp) => {
                                const p = rp.players
                                const isDroppingThis = dropping === rp.id
                                return (
                                    <View key={rp.id} style={styles.dropRow}>
                                        <Avatar
                                            name={p.display_name}
                                            color={POSITION_COLORS[p.position ?? ''] ?? palette.gray500}
                                            size={38}
                                        />
                                        <View style={styles.dropInfo}>
                                            <Text style={styles.dropName} numberOfLines={1}>{p.display_name}</Text>
                                            <Text style={styles.dropMeta}>
                                                {[p.nba_team, p.position].filter(Boolean).join(' · ')}
                                            </Text>
                                        </View>
                                        <Pressable
                                            style={styles.dropBtn}
                                            onPress={() => handleDropAndAdd(rp)}
                                            disabled={dropping !== null}
                                        >
                                            {isDroppingThis
                                                ? <ActivityIndicator size="small" color={colors.textWhite} />
                                                : <Text style={styles.dropBtnText}>Drop</Text>}
                                        </Pressable>
                                    </View>
                                )
                            })}
                        </ScrollView>

                        <Pressable
                            style={styles.modalCancel}
                            onPress={() => setDropPickerPlayer(null)}
                            disabled={dropping !== null}
                        >
                            <Text style={styles.modalCancelText}>Cancel</Text>
                        </Pressable>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    flex1: { flex: 1 },

    searchRow: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg },
    searchInput: {
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg + spacing.xxs,
        fontSize: fontSize.lg,
    },

    positionScrollView: { flexGrow: 0, flexShrink: 0 },
    positionRow: { paddingLeft: spacing.xl, paddingRight: spacing['4xl'], paddingBottom: spacing.lg, gap: spacing.md },
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

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.lg,
        gap: 0,
    },
    addCol: { width: 36, alignItems: 'center' },
    addBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addBtnText: { color: colors.textWhite, fontSize: fontSize.xl, fontWeight: fontWeight.light, lineHeight: 24, marginTop: -1 },

    playerCard: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: spacing.xl,
        paddingVertical: spacing.lg,
        paddingLeft: spacing.md,
        gap: spacing.lg,
    },

    playerInfo: { flex: 1 },
    playerName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: spacing.xxs },

    statusBadge: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.gray250,
        maxWidth: 90,
    },
    statusBadgeMe: { backgroundColor: palette.green300 },
    statusBadgeWaiver: { backgroundColor: palette.purple100 },
    statusBadgeFA: { backgroundColor: palette.gray250 },
    statusBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
    statusBadgeTextMe: { color: palette.green600 },
    statusBadgeTextWaiver: { color: '#7C3AED' },

    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

    // Drop picker modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalCard: {
        backgroundColor: colors.bgScreen,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingTop: spacing['3xl'],
        paddingHorizontal: spacing['2xl'],
        paddingBottom: 36,
        maxHeight: '80%',
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    modalPlayerName: { color: colors.primary },
    modalSub: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginBottom: spacing.xl },

    dropList: { maxHeight: 360 },
    dropRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.lg,
    },
    dropInfo: { flex: 1 },
    dropName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    dropMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    dropBtn: {
        backgroundColor: colors.danger,
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: colors.textWhite, fontSize: fontSize.sm, fontWeight: fontWeight.bold },

    modalCancel: {
        marginTop: spacing.xl,
        paddingVertical: spacing.lg + spacing.xxs,
        alignItems: 'center',
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
    },
    modalCancelText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
