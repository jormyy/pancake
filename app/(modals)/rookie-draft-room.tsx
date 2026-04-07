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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import {
    getRookieDraftState,
    getRookiePlayers,
    makeSnakePick,
    autoPickBest,
    subscribeToRookieDraft,
    unsubscribeFromRookieDraft,
    type RookieDraftState,
    type SnakePick,
} from '@/lib/rookieDraft'
import { POSITION_COLORS } from '@/constants/positions'
import { bgStyle } from '@/lib/style-cache'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

const PICK_TIMEOUT_SEC = 90

export default function RookieDraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current } = useLeagueContext()
    const myMemberId = (current as any)?.id

    const [state, setState] = useState<RookieDraftState | null>(null)
    const [loading, setLoading] = useState(true)

    const [query, setQuery] = useState('')
    const [prospects, setProspects] = useState<any[]>([])
    const [prospectsLoading, setProspectsLoading] = useState(false)
    const [picking, setPicking] = useState(false)
    const [activeTab, setActiveTab] = useState<'prospects' | 'board'>('prospects')

    const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
    const autoPickFiredRef = useRef(false)

    const channelRef = useRef<any>(null)
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const load = useCallback(async () => {
        if (!draftId) return
        const data = await getRookieDraftState(draftId)
        setState(data)
        setLoading(false)
    }, [draftId])

    const loadProspects = useCallback(async (q?: string) => {
        if (!draftId) return
        setProspectsLoading(true)
        const data = await getRookiePlayers(draftId, q)
        setProspects(data)
        setProspectsLoading(false)
    }, [draftId])

    useEffect(() => {
        load()
        if (!draftId) return
        channelRef.current = subscribeToRookieDraft(draftId, () => {
            load()
            loadProspects(query.trim() || undefined)
        })
        return () => {
            if (channelRef.current) unsubscribeFromRookieDraft(channelRef.current)
        }
    }, [draftId, load, loadProspects])

    // Initial prospects load
    useEffect(() => {
        loadProspects()
    }, [loadProspects])

    // Debounced prospects search
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(() => {
            loadProspects(query.trim() || undefined)
        }, 300)
        return () => {
            if (searchTimer.current) clearTimeout(searchTimer.current)
        }
    }, [query])

    // Derive when the current pick's clock started
    const clockEnd = useMemo(() => {
        if (!state || state.draft.status !== 'in_progress') return null
        const { picks, draft } = state
        const made = picks.filter((p) => p.player).sort((a, b) => b.overallPick - a.overallPick)
        const start = made[0]?.pickedAt ?? draft.startedAt
        if (!start) return null
        return new Date(start).getTime() + PICK_TIMEOUT_SEC * 1000
    }, [state?.picks.filter((p) => p.player).length, state?.draft.status])

    // Tick the countdown
    useEffect(() => {
        if (!clockEnd) { setSecondsLeft(null); return }
        autoPickFiredRef.current = false
        const tick = () => setSecondsLeft(Math.max(0, Math.ceil((clockEnd - Date.now()) / 1000)))
        tick()
        const id = setInterval(tick, 500)
        return () => clearInterval(id)
    }, [clockEnd])

    // Auto-pick when clock hits 0 and it's my turn
    useEffect(() => {
        if (secondsLeft !== 0 || !draftId || !myMemberId || picking) return
        if (autoPickFiredRef.current) return
        const isMyTurnNow = state?.nextPick?.memberId === myMemberId
        if (!isMyTurnNow) return
        autoPickFiredRef.current = true
        ;(async () => {
            setPicking(true)
            try {
                await autoPickBest(draftId, myMemberId)
                setQuery('')
                await Promise.all([load(), loadProspects()])
            } catch (e: any) {
                Alert.alert('Auto-pick failed', e.message)
            } finally {
                setPicking(false)
            }
        })()
    }, [secondsLeft])

    async function handlePick(player: any) {
        if (!draftId || !myMemberId) return
        Alert.alert('Confirm Pick', `Select ${player.display_name}?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Pick',
                onPress: async () => {
                    setPicking(true)
                    try {
                        await makeSnakePick(draftId, myMemberId, player.id)
                        setQuery('')
                        await Promise.all([load(), loadProspects()])
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
                                <View style={styles.bannerRow}>
                                    <Text style={styles.bannerTitle}>
                                        Round {currentRound} · Pick {madePicks + 1} of {totalPicks}
                                    </Text>
                                    {secondsLeft != null && (
                                        <Text style={[
                                            styles.bannerClock,
                                            secondsLeft <= 10 && styles.bannerClockUrgent,
                                        ]}>
                                            {secondsLeft}s
                                        </Text>
                                    )}
                                </View>
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

                    {/* ── Tab switcher ─────────────────────────── */}
                    <View style={styles.tabs}>
                        <Pressable
                            style={[styles.tab, activeTab === 'prospects' && styles.tabActive]}
                            onPress={() => setActiveTab('prospects')}
                        >
                            <Text style={[styles.tabText, activeTab === 'prospects' && styles.tabTextActive]}>
                                Prospects
                            </Text>
                        </Pressable>
                        <Pressable
                            style={[styles.tab, activeTab === 'board' && styles.tabActive]}
                            onPress={() => setActiveTab('board')}
                        >
                            <Text style={[styles.tabText, activeTab === 'board' && styles.tabTextActive]}>
                                Pick Board
                            </Text>
                        </Pressable>
                    </View>

                    {activeTab === 'prospects' ? (
                        <>
                            {/* ── Search bar ───────────────────────── */}
                            <View style={styles.searchContainer}>
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Search prospects…"
                                    placeholderTextColor={colors.textPlaceholder}
                                    value={query}
                                    onChangeText={setQuery}
                                    autoCorrect={false}
                                    returnKeyType="search"
                                />
                                {prospectsLoading && (
                                    <ActivityIndicator
                                        size="small"
                                        color={colors.primary}
                                        style={styles.searchSpinner}
                                    />
                                )}
                            </View>

                            {/* ── Prospects list ───────────────────── */}
                            <FlashList
                                data={prospects}
                                keyExtractor={(p) => p.id}
                                ItemSeparatorComponent={ItemSeparator}
                                estimatedItemSize={56}
                                ListEmptyComponent={
                                    !prospectsLoading ? (
                                        <View style={styles.emptyProspects}>
                                            <Text style={styles.emptyText}>
                                                {query.trim() ? 'No matching prospects' : 'No prospects available'}
                                            </Text>
                                        </View>
                                    ) : null
                                }
                                renderItem={({ item }) => (
                                    <ProspectRow
                                        player={item}
                                        isDone={isDone}
                                        picking={picking}
                                        onPick={handlePick}
                                    />
                                )}
                            />
                        </>
                    ) : (
                        /* ── Pick board ──────────────────────────── */
                        <FlashList
                            data={picks}
                            keyExtractor={(p) => String(p.overallPick)}
                            ItemSeparatorComponent={ItemSeparator}
                            estimatedItemSize={48}
                            ListHeaderComponent={PickBoardHeader}
                            renderItem={({ item }) => (
                                <PickRow item={item} myMemberId={myMemberId} nextPick={nextPick} />
                            )}
                        />
                    )}
                </KeyboardAvoidingView>
            </SafeAreaView>
        </>
    )
}

function ProspectRow({
    player,
    isDone,
    picking,
    onPick,
}: {
    player: any
    isDone: boolean
    picking: boolean
    onPick: (player: any) => void
}) {
    return (
        <Pressable
            style={styles.resultRow}
            onPress={isDone ? undefined : () => onPick(player)}
            disabled={isDone || picking}
        >
            {player.nba_draft_number != null ? (
                <View style={styles.draftNumChip}>
                    <Text style={styles.draftNumText}>{player.nba_draft_number}</Text>
                </View>
            ) : (
                <View style={[styles.posChip, { backgroundColor: POSITION_COLORS[player.position] ?? palette.gray500 }]}>
                    <Text style={styles.posChipText}>{player.position ?? '?'}</Text>
                </View>
            )}
            <View style={styles.resultInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.resultName}>{player.display_name}</Text>
                    {player.nba_draft_number != null && (
                        <View style={[styles.posChipXs, { backgroundColor: POSITION_COLORS[player.position] ?? palette.gray500 }]}>
                            <Text style={styles.posChipXsText}>{player.position ?? '?'}</Text>
                        </View>
                    )}
                </View>
                <Text style={styles.resultTeam}>{player.nba_team ?? 'FA'}</Text>
            </View>
            {!isDone && (
                picking ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                    <Text style={styles.pickBtn}>Pick</Text>
                )
            )}
        </Pressable>
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
    bannerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    bannerTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    bannerClock: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textMuted },
    bannerClockUrgent: { color: colors.danger },
    bannerSub: { fontSize: fontSize.md, color: colors.textSecondary },
    bannerMe: { color: colors.primary, fontWeight: fontWeight.bold },

    tabs: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    tab: {
        flex: 1,
        paddingVertical: 10,
        alignItems: 'center',
    },
    tabActive: {
        borderBottomWidth: 2,
        borderBottomColor: colors.primary,
    },
    tabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    tabTextActive: { color: colors.primary },

    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        margin: spacing.lg,
        marginBottom: spacing.md,
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

    emptyProspects: { paddingVertical: 40, alignItems: 'center' },

    resultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 10,
        gap: 10,
    },
    resultInfo: { flex: 1 },
    resultName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    resultTeam: { fontSize: 12, color: colors.textMuted },
    pickBtn: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primary },

    draftNumChip: {
        width: 36,
        height: 36,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    draftNumText: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    posChip: {
        width: 36,
        height: 36,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    posChipText: { color: colors.textWhite, fontSize: fontSize.xs, fontWeight: fontWeight.bold },

    posChipXs: {
        paddingHorizontal: 5,
        paddingVertical: 2,
        borderRadius: radii.xs ?? 4,
        borderCurve: 'continuous' as const,
    },
    posChipXsText: { color: colors.textWhite, fontSize: 10, fontWeight: fontWeight.bold },

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
