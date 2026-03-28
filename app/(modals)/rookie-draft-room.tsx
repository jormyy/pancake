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
import { bgStyle } from '@/lib/style-cache'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

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
                <ActivityIndicator style={{ flex: 1 }} color={colors.primary} />
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
                                placeholderTextColor={colors.textPlaceholder}
                                value={query}
                                onChangeText={setQuery}
                                autoCorrect={false}
                                returnKeyType="search"
                            />
                            {searching && (
                                <ActivityIndicator
                                    size="small"
                                    color={colors.primary}
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
                                            { backgroundColor: POSITION_COLORS[p.position] ?? palette.gray500 },
                                        ]}
                                    >
                                        <Text style={styles.posChipText}>{p.position ?? '?'}</Text>
                                    </View>
                                    <View style={styles.resultInfo}>
                                        <Text style={styles.resultName}>{p.display_name}</Text>
                                        <Text style={styles.resultTeam}>{p.nba_team ?? 'FA'}</Text>
                                    </View>
                                    {picking ? (
                                        <ActivityIndicator size="small" color={colors.primary} />
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
                        ListHeaderComponent={PickBoardHeader}
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
                            bgStyle(POSITION_COLORS[item.player.position ?? ''] ?? palette.gray500),
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
    container: { flex: 1, backgroundColor: colors.bgScreen },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { color: colors.textPlaceholder, fontSize: fontSize.md },

    banner: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: palette.orange100,
        paddingHorizontal: spacing['2xl'],
        paddingVertical: 14,
        gap: spacing.xs,
    },
    bannerDone: { backgroundColor: palette.green50, borderBottomColor: palette.green200 },
    bannerTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    bannerSub: { fontSize: fontSize.md, color: colors.textSecondary },
    bannerMe: { color: colors.primary, fontWeight: fontWeight.bold },

    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        margin: spacing.lg,
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: colors.bgSubtle,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.primary,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.textPrimary },
    searchSpinner: { marginLeft: spacing.md },

    resultsContainer: {
        marginHorizontal: spacing.lg,
        marginBottom: spacing.md,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
        backgroundColor: colors.bgScreen,
    },
    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: 10,
    },
    resultInfo: { flex: 1 },
    resultName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    resultTeam: { fontSize: 12, color: colors.textMuted },
    pickBtn: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primary },

    posChip: {
        width: 36,
        height: 36,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    posChipText: { color: colors.textWhite, fontSize: fontSize.xs, fontWeight: fontWeight.bold },

    posChipSm: {
        width: 28,
        height: 28,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    posChipSmText: { color: colors.textWhite, fontSize: 10, fontWeight: fontWeight.bold },

    separator: { height: 1, backgroundColor: colors.separator },

    pickHeader: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.md },
    headerText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },

    pickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 10,
        gap: spacing.md,
    },
    pickRowMe: { backgroundColor: colors.primaryLight },
    pickRowOnClock: { backgroundColor: palette.green50 },

    pickNum: { width: 28, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted },
    pickTeam: { width: 100, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    pickPlayer: { flex: 1, fontSize: fontSize.sm, color: colors.textPlaceholder },

    pickPlayerCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    pickedName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    pickedTeam: { fontSize: fontSize.xs, color: colors.textMuted },

    onClockText: { color: colors.success, fontWeight: fontWeight.bold },
    meText: { color: colors.primary, fontWeight: fontWeight.bold },
})

const PickBoardHeader = (
    <View style={[styles.pickRow, styles.pickHeader]}>
        <Text style={[styles.pickNum, styles.headerText]}>#</Text>
        <Text style={[styles.pickTeam, styles.headerText]}>Team</Text>
        <Text style={[styles.pickPlayer, styles.headerText]}>Player</Text>
    </View>
)
