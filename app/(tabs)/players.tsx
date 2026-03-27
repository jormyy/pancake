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
import { useFocusEffect } from '@react-navigation/native'
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
import { bgStyle } from '@/lib/style-cache'

const POSITIONS = ['ALL', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']

const ItemSeparator = () => <View style={styles.separator} />

const INJURY_COLORS: Record<string, string> = {
    Questionable: '#F59E0B',
    Doubtful: '#F97316',
    Out: '#EF4444',
    IR: '#7F1D1D',
}

function getInitials(name: string): string {
    return name.split(' ').map((w) => w[0]).slice(0, 2).join('')
}

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
                            ? <ActivityIndicator size="small" color="#F97316" />
                            : <Text style={styles.addBtnText}>+</Text>}
                    </Pressable>
                ) : null}
            </View>

            {/* Player card (tappable → detail) */}
            <Pressable style={styles.playerCard} onPress={onPress}>
                <View style={[styles.avatar, bgStyle(POSITION_COLORS[item.position ?? ''] ?? '#ccc')]}>
                    <Text style={styles.avatarText}>{getInitials(item.display_name)}</Text>
                </View>

                <View style={styles.playerInfo}>
                    <Text style={styles.playerName}>{item.display_name}</Text>
                    <Text style={styles.playerMeta}>
                        {[item.nba_team, item.position].filter(Boolean).join(' · ')}
                    </Text>
                </View>

                {/* Injury badge */}
                {item.injury_status ? (
                    <View style={[styles.injuryBadge, bgStyle(INJURY_COLORS[item.injury_status] ?? '#888')]}>
                        <Text style={styles.injuryText}>{item.injury_status}</Text>
                    </View>
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
    const [ownedMap, setOwnedMap] = useState<Map<string, OwnedEntry>>(new Map())
    const [waiverIds, setWaiverIds] = useState<Set<string>>(new Set())

    // Quick-add state
    const [adding, setAdding] = useState<string | null>(null)
    const [dropPickerPlayer, setDropPickerPlayer] = useState<PlayerRow | null>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [dropping, setDropping] = useState<string | null>(null)

    const loadOwned = useCallback(async () => {
        if (!current) return
        const league = current.leagues as any
        try {
            const [om, wIds] = await Promise.all([
                getOwnedPlayerMap(league.id),
                getWaiverPlayerIds(league.id),
            ])
            setOwnedMap(om)
            setWaiverIds(wIds)
        } catch (e) {
            console.error(e)
        }
    }, [current])

    useFocusEffect(useCallback(() => { loadOwned() }, [loadOwned]))

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
                                await loadOwned()
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
            await loadOwned()
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
            await loadOwned()
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
                    placeholderTextColor="#aaa"
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
                <ActivityIndicator style={styles.flex1} color="#F97316" />
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
                    ListEmptyComponent={<Text style={styles.emptyText}>No players found.</Text>}
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
                                        <View style={[styles.dropAvatar, bgStyle(POSITION_COLORS[p.position ?? ''] ?? '#ccc')]}>
                                            <Text style={styles.dropAvatarText}>
                                                {getInitials(p.display_name)}
                                            </Text>
                                        </View>
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
                                                ? <ActivityIndicator size="small" color="#fff" />
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
    container: { flex: 1, backgroundColor: '#fff' },
    flex1: { flex: 1 },

    searchRow: { paddingHorizontal: 16, paddingVertical: 10 },
    searchInput: {
        height: 44,
        backgroundColor: '#f3f3f3',
        borderRadius: 10,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        fontSize: 16,
    },

    positionScrollView: { flexGrow: 0, flexShrink: 0 },
    positionRow: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
    posChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderCurve: 'continuous' as const, backgroundColor: '#f3f3f3' },
    posChipActive: { backgroundColor: '#F97316' },
    posChipText: { fontSize: 13, fontWeight: '600', color: '#555' },
    posChipTextActive: { color: '#fff' },

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 12,
        gap: 0,
    },
    separator: { height: 1, backgroundColor: '#f3f3f3', marginLeft: 72 },

    addCol: { width: 36, alignItems: 'center' },
    addBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        backgroundColor: '#F97316',
        alignItems: 'center',
        justifyContent: 'center',
    },
    addBtnText: { color: '#fff', fontSize: 20, fontWeight: '300', lineHeight: 24, marginTop: -1 },

    playerCard: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 16,
        paddingVertical: 12,
        paddingLeft: 8,
        gap: 12,
    },

    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    playerInfo: { flex: 1 },
    playerName: { fontSize: 16, fontWeight: '600' },
    playerMeta: { fontSize: 13, color: '#888', marginTop: 2 },

    injuryBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderCurve: 'continuous' as const },
    injuryText: { color: '#fff', fontSize: 11, fontWeight: '700' },

    statusBadge: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        borderCurve: 'continuous' as const,
        backgroundColor: '#f0f0f0',
        maxWidth: 90,
    },
    statusBadgeMe: { backgroundColor: '#DCFCE7' },
    statusBadgeWaiver: { backgroundColor: '#EDE9FE' },
    statusBadgeFA: { backgroundColor: '#f0f0f0' },
    statusBadgeText: { fontSize: 11, fontWeight: '700', color: '#aaa' },
    statusBadgeTextMe: { color: '#16A34A' },
    statusBadgeTextWaiver: { color: '#7C3AED' },

    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { color: '#aaa', fontSize: 15 },

    // Drop picker modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalCard: {
        backgroundColor: '#fff',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderCurve: 'continuous' as const,
        paddingTop: 24,
        paddingHorizontal: 20,
        paddingBottom: 36,
        maxHeight: '80%',
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: '700',
        color: '#111',
        textAlign: 'center',
        marginBottom: 4,
    },
    modalPlayerName: { color: '#F97316' },
    modalSub: { fontSize: 13, color: '#aaa', textAlign: 'center', marginBottom: 16 },

    dropList: { maxHeight: 360 },
    dropRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f3f3',
        gap: 12,
    },
    dropAvatar: {
        width: 38,
        height: 38,
        borderRadius: 19,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    dropAvatarText: { color: '#fff', fontWeight: '700', fontSize: 12 },
    dropInfo: { flex: 1 },
    dropName: { fontSize: 14, fontWeight: '600', color: '#111' },
    dropMeta: { fontSize: 12, color: '#888', marginTop: 1 },
    dropBtn: {
        backgroundColor: '#EF4444',
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

    modalCancel: {
        marginTop: 16,
        paddingVertical: 14,
        alignItems: 'center',
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        backgroundColor: '#f5f5f5',
    },
    modalCancelText: { fontSize: 15, fontWeight: '600', color: '#555' },
})
