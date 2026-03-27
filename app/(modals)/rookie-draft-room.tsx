import {
    View,
    Text,
    Pressable,
    TextInput,
    StyleSheet,
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getRookieDraftState,
    makeSnakePick,
    searchDraftablePlayers,
    subscribeToRookieDraft,
    unsubscribeFromRookieDraft,
    type RookieDraftState,
    type SnakePick,
} from '@/lib/rookieDraft'
import { POSITION_COLORS } from '@/constants/positions'

export default function RookieDraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current } = useLeagueContext()
    const myMemberId = (current as any)?.id

    const [state, setState] = useState<RookieDraftState | null>(null)
    const [loading, setLoading] = useState(true)

    const [query, setQuery] = useState('')
    const [searchResults, setSearchResults] = useState<any[]>([])
    const [searching, setSearching] = useState(false)
    const [picking, setPicking] = useState(false)

    const channelRef = useRef<any>(null)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const load = useCallback(async () => {
        if (!draftId) return
        const data = await getRookieDraftState(draftId)
        setState(data)
        setLoading(false)
    }, [draftId])

    useEffect(() => {
        load()
        if (!draftId) return
        channelRef.current = subscribeToRookieDraft(draftId, load)
        return () => {
            if (channelRef.current) unsubscribeFromRookieDraft(channelRef.current)
        }
    }, [draftId, load])

    // Debounced player search
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current)
        if (!query.trim() || !draftId) {
            setSearchResults([])
            return
        }
        setSearching(true)
        searchTimer.current = setTimeout(async () => {
            const results = await searchDraftablePlayers(query.trim(), draftId)
            setSearchResults(results)
            setSearching(false)
        }, 300)
        return () => {
            if (searchTimer.current) clearTimeout(searchTimer.current)
        }
    }, [query, draftId])

    async function handlePick(player: any) {
        if (!draftId || !myMemberId) return
        if (picking) return
        Alert.alert('Confirm Pick', `Select ${player.display_name}?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Pick',
                onPress: async () => {
                    setPicking(true)
                    try {
                        await makeSnakePick(draftId, myMemberId, player.id)
                        setQuery('')
                        setSearchResults([])
                    } catch (e: any) {
                        Alert.alert('Error', e.message)
                    } finally {
                        setPicking(false)
                    }
                },
            },
        ])
    }

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <Stack.Screen options={{ title: 'Rookie Draft', presentation: 'modal' }} />
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            </SafeAreaView>
        )
    }

    if (!state) {
        return (
            <SafeAreaView style={styles.container}>
                <Stack.Screen options={{ title: 'Rookie Draft', presentation: 'modal' }} />
                <View style={styles.center}>
                    <Text style={styles.emptyText}>Draft not found.</Text>
                </View>
            </SafeAreaView>
        )
    }

    const { draft, picks, nextPick } = state
    const isMyTurn = nextPick?.memberId === myMemberId
    const isDone = draft.status === 'completed'

    const totalPicks = picks.length
    const madePicks = picks.filter((p) => p.player).length
    const currentRound = nextPick?.round ?? Math.ceil(totalPicks / state.orders.length)
    const pickInRound = nextPick?.pickInRound ?? 0
    const totalInRound = state.orders.length

    return (
        <>
            <Stack.Screen options={{ title: 'Rookie Draft', presentation: 'modal' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <KeyboardAvoidingView
                    style={{ flex: 1 }}
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                >
                    {/* ── Status banner ────────────────────────── */}
                    <View style={[styles.banner, isDone && styles.bannerDone]}>
                        {isDone ? (
                            <Text style={styles.bannerTitle}>Draft Complete</Text>
                        ) : (
                            <>
                                <Text style={styles.bannerTitle}>
                                    Round {currentRound} · Pick {madePicks + 1} of {totalPicks}
                                </Text>
                                {nextPick && (
                                    <Text style={styles.bannerSub}>
                                        On the clock:{' '}
                                        <Text style={[styles.bannerSub, isMyTurn && styles.bannerMe]}>
                                            {nextPick.teamName}
                                            {isMyTurn ? ' (you)' : ''}
                                        </Text>
                                    </Text>
                                )}
                            </>
                        )}
                    </View>

                    {/* ── Search (only when it's your turn) ───── */}
                    {isMyTurn && !isDone && (
                        <View style={styles.searchContainer}>
                            <TextInput
                                style={styles.searchInput}
                                placeholder="Search players…"
                                placeholderTextColor="#aaa"
                                value={query}
                                onChangeText={setQuery}
                                autoCorrect={false}
                                returnKeyType="search"
                            />
                            {searching && (
                                <ActivityIndicator
                                    size="small"
                                    color="#F97316"
                                    style={styles.searchSpinner}
                                />
                            )}
                        </View>
                    )}

                    {/* ── Search results ───────────────────────── */}
                    {isMyTurn && searchResults.length > 0 && (
                        <View style={styles.resultsContainer}>
                            {searchResults.map((p) => (
                                <Pressable
                                    key={p.id}
                                    style={styles.resultRow}
                                    onPress={() => handlePick(p)}
                                    disabled={picking}
                                >
                                    <View
                                        style={[
                                            styles.posChip,
                                            { backgroundColor: POSITION_COLORS[p.position] ?? '#ccc' },
                                        ]}
                                    >
                                        <Text style={styles.posChipText}>{p.position ?? '?'}</Text>
                                    </View>
                                    <View style={styles.resultInfo}>
                                        <Text style={styles.resultName}>{p.display_name}</Text>
                                        <Text style={styles.resultTeam}>{p.nba_team ?? 'FA'}</Text>
                                    </View>
                                    {picking ? (
                                        <ActivityIndicator size="small" color="#F97316" />
                                    ) : (
                                        <Text style={styles.pickBtn}>Pick</Text>
                                    )}
                                </Pressable>
                            ))}
                        </View>
                    )}

                    {/* ── Pick board ───────────────────────────── */}
                    <FlashList
                        data={picks}
                        keyExtractor={(p) => String(p.overallPick)}
                        ItemSeparatorComponent={ItemSeparator}
                        ListHeaderComponent={() => (
                            <View style={[styles.pickRow, styles.pickHeader]}>
                                <Text style={[styles.pickNum, styles.headerText]}>#</Text>
                                <Text style={[styles.pickTeam, styles.headerText]}>Team</Text>
                                <Text style={[styles.pickPlayer, styles.headerText]}>Player</Text>
                            </View>
                        )}
                        renderItem={({ item }) => <PickRow item={item} myMemberId={myMemberId} nextPick={nextPick} />}
                    />
                </KeyboardAvoidingView>

            </SafeAreaView>
        </>
    )
}

function PickRow({
    item,
    myMemberId,
    nextPick,
}: {
    item: SnakePick
    myMemberId?: string
    nextPick: SnakePick | null
}) {
    const isMe = item.memberId === myMemberId
    const isOnClock = !item.player && nextPick?.overallPick === item.overallPick

    return (
        <View
            style={[
                styles.pickRow,
                isMe && styles.pickRowMe,
                isOnClock && styles.pickRowOnClock,
            ]}
        >
            <Text style={[styles.pickNum, isMe && styles.meText]}>
                {item.overallPick}
            </Text>
            <Text style={[styles.pickTeam, isMe && styles.meText]} numberOfLines={1}>
                {item.teamName}
                {item.round > 1 && item.pickInRound === 1
                    ? `\nRd ${item.round}`
                    : ''}
            </Text>
            {item.player ? (
                <View style={styles.pickPlayerCell}>
                    <View
                        style={[
                            styles.posChipSm,
                            {
                                backgroundColor:
                                    POSITION_COLORS[item.player.position ?? ''] ?? '#ccc',
                            },
                        ]}
                    >
                        <Text style={styles.posChipSmText}>{item.player.position ?? '?'}</Text>
                    </View>
                    <View>
                        <Text style={[styles.pickedName, isMe && styles.meText]} numberOfLines={1}>
                            {item.player.displayName}
                        </Text>
                        <Text style={styles.pickedTeam}>{item.player.nbaTeam ?? 'FA'}</Text>
                    </View>
                </View>
            ) : (
                <Text style={[styles.pickPlayer, isOnClock && styles.onClockText]}>
                    {isOnClock ? '▶ On the clock' : '—'}
                </Text>
            )}
        </View>
    )
}

const ItemSeparator = () => <View style={styles.separator} />

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { color: '#aaa', fontSize: 14 },

    banner: {
        backgroundColor: '#FFF7ED',
        borderBottomWidth: 1,
        borderBottomColor: '#FFE4CC',
        paddingHorizontal: 20,
        paddingVertical: 14,
        gap: 4,
    },
    bannerDone: { backgroundColor: '#F0FDF4', borderBottomColor: '#BBF7D0' },
    bannerTitle: { fontSize: 16, fontWeight: '800', color: '#111' },
    bannerSub: { fontSize: 14, color: '#555' },
    bannerMe: { color: '#F97316', fontWeight: '700' },

    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        margin: 12,
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: '#f5f5f5',
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: '#F97316',
    },
    searchInput: { flex: 1, fontSize: 15, color: '#111' },
    searchSpinner: { marginLeft: 8 },

    resultsContainer: {
        marginHorizontal: 12,
        marginBottom: 8,
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: '#eee',
        overflow: 'hidden',
        backgroundColor: '#fff',
    },
    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f3f3',
        gap: 10,
    },
    resultInfo: { flex: 1 },
    resultName: { fontSize: 14, fontWeight: '600', color: '#111' },
    resultTeam: { fontSize: 12, color: '#888' },
    pickBtn: { fontSize: 14, fontWeight: '700', color: '#F97316' },

    posChip: {
        width: 36,
        height: 36,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    posChipText: { color: '#fff', fontSize: 11, fontWeight: '700' },

    posChipSm: {
        width: 28,
        height: 28,
        borderRadius: 6,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    posChipSmText: { color: '#fff', fontSize: 10, fontWeight: '700' },

    separator: { height: 1, backgroundColor: '#f3f3f3' },

    pickHeader: { borderBottomWidth: 1, borderBottomColor: '#eee', paddingVertical: 8 },
    headerText: { fontSize: 11, fontWeight: '700', color: '#aaa' },

    pickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 8,
    },
    pickRowMe: { backgroundColor: '#FFF7ED' },
    pickRowOnClock: { backgroundColor: '#F0FDF4' },

    pickNum: { width: 28, fontSize: 13, fontWeight: '700', color: '#888' },
    pickTeam: { width: 100, fontSize: 13, fontWeight: '600', color: '#111' },
    pickPlayer: { flex: 1, fontSize: 13, color: '#aaa' },

    pickPlayerCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    pickedName: { fontSize: 13, fontWeight: '600', color: '#111' },
    pickedTeam: { fontSize: 11, color: '#888' },

    onClockText: { color: '#10B981', fontWeight: '700' },
    meText: { color: '#F97316', fontWeight: '700' },
})
