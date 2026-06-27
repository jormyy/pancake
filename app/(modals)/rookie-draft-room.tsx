import {
    View,
    Text,
    TextInput,
    StyleSheet,
    ActivityIndicator,
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { type RookieProspect, type SnakePick } from '@/lib/rookieDraft'
import { getPositionColor } from "@/constants/positions"
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { MotionPressable, MotionView } from '@/components/Motion'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'

export default function RookieDraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current, currentLeague } = useLeagueContext()
    const myMemberId = current?.id
    const {
        state,
        loading,
        query,
        setQuery,
        prospects,
        prospectsLoading,
        picking,
        activeTab,
        setActiveTab,
        secondsLeft,
        pickError,
        rosterOverflow,
        rosterForDrop,
        resolvingOverflow,
        trimOverflow,
        trimmingId,
        memberId,
        handleTrimDrop,
        handlePick,
        resolveByTaxi,
        resolveByDrop,
    } = useRookieDraftRoomController({
        draftId,
        memberId: myMemberId,
        leagueId: currentLeague?.id,
        rosterSize: currentLeague?.roster_size ?? 20,
    })

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
    const isMyTurn = nextPick?.memberId === memberId
    const isDone = draft.status === 'completed'

    const totalPicks = picks.length
    const madePicks = picks.filter((p) => p.player).length
    const currentRound = nextPick?.round ?? Math.ceil(totalPicks / state.orders.length)

    return (
        <>
            <Stack.Screen options={{ title: 'Rookie Draft', presentation: 'modal' }} />

            {/* ── Roster overflow resolution modal (non-dismissable) ── */}
            <Modal visible={!!rosterOverflow} transparent animationType="slide">
                <View style={styles.overflowOverlay}>
                    <View style={styles.overflowCard}>
                        <Text style={styles.overflowTitle}>Roster Full</Text>
                        <Text style={styles.overflowBody}>
                            You drafted{' '}
                            <Text style={{ fontWeight: '700' }}>{rosterOverflow?.newPlayerName}</Text>
                            {' '}but your active roster is over capacity. Resolve before continuing.
                        </Text>

                        {rosterOverflow?.taxiSlotsAvailable && (
                            <MotionPressable
                                style={[styles.overflowBtn, styles.overflowBtnPrimary]}
                                onPress={resolveByTaxi}
                                disabled={resolvingOverflow}
                                pressedScale={0.965}
                            >
                                {resolvingOverflow ? (
                                    <ActivityIndicator color={colors.textWhite} />
                                ) : (
                                    <Text style={styles.overflowBtnPrimaryText}>
                                        Move {rosterOverflow?.newPlayerName} to Taxi Squad
                                    </Text>
                                )}
                            </MotionPressable>
                        )}

                        {rosterForDrop.length > 0 && (
                            <>
                                <Text style={styles.overflowDropLabel}>Or drop a player:</Text>
                                <ScrollView style={styles.overflowDropList} showsVerticalScrollIndicator>
                                    {rosterForDrop.map((rp) => (
                                        <MotionPressable
                                            key={rp.id}
                                            style={styles.overflowDropRow}
                                            onPress={() => resolveByDrop(rp.id)}
                                            disabled={resolvingOverflow}
                                            pressedScale={0.975}
                                        >
                                            <Text style={styles.overflowDropName}>
                                                {rp.players?.display_name ?? 'Player'}
                                            </Text>
                                            <Text style={styles.overflowDropPos}>
                                                {rp.players?.position ?? ''} · {rp.players?.nba_team ?? ''}
                                            </Text>
                                        </MotionPressable>
                                    ))}
                                </ScrollView>
                            </>
                        )}
                    </View>
                </View>
            </Modal>

            {/* ── End-of-draft roster trim modal (non-dismissable) ── */}
            <Modal visible={!!trimOverflow} transparent animationType="slide">
                <View style={styles.overflowOverlay}>
                    <View style={styles.overflowCard}>
                        <Text style={styles.overflowTitle}>Trim Your Roster</Text>
                        <Text style={styles.overflowBody}>
                            Your active roster is{' '}
                            <Text style={{ fontWeight: '700' }}>{trimOverflow?.excess ?? 0} over</Text>
                            {' '}the limit. Drop {trimOverflow?.excess === 1 ? 'a player' : `${trimOverflow?.excess} players`} to continue.
                        </Text>
                        <Text style={styles.overflowDropLabel}>Select a player to drop:</Text>
                        <ScrollView style={styles.overflowDropList} showsVerticalScrollIndicator>
                            {trimOverflow?.dropList.map((rp) => (
                                <MotionPressable
                                    key={rp.id}
                                    style={styles.overflowDropRow}
                                    onPress={() => handleTrimDrop(rp.id)}
                                    disabled={!!trimmingId}
                                    pressedScale={0.975}
                                >
                                    {trimmingId === rp.id ? (
                                        <ActivityIndicator size="small" color={colors.danger} />
                                    ) : (
                                        <>
                                            <Text style={styles.overflowDropName}>
                                                {rp.players?.display_name ?? 'Player'}
                                            </Text>
                                            <Text style={styles.overflowDropPos}>
                                                {rp.players?.position ?? ''} · {rp.players?.nba_team ?? ''}
                                            </Text>
                                        </>
                                    )}
                                </MotionPressable>
                            ))}
                        </ScrollView>
                    </View>
                </View>
            </Modal>

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
                        <MotionPressable
                            style={[styles.tab, activeTab === 'prospects' && styles.tabActive]}
                            onPress={() => setActiveTab('prospects')}
                            pressedScale={0.96}
                        >
                            <Text style={[styles.tabText, activeTab === 'prospects' && styles.tabTextActive]}>
                                Prospects
                            </Text>
                        </MotionPressable>
                        <MotionPressable
                            style={[styles.tab, activeTab === 'board' && styles.tabActive]}
                            onPress={() => setActiveTab('board')}
                            pressedScale={0.96}
                        >
                            <Text style={[styles.tabText, activeTab === 'board' && styles.tabTextActive]}>
                                Pick Board
                            </Text>
                        </MotionPressable>
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

                            {/* ── Pick error ───────────────────────── */}
                            {pickError && (
                                <View style={styles.pickErrorBanner}>
                                    <Text style={styles.pickErrorText}>{pickError}</Text>
                                </View>
                            )}

                            {/* ── Prospects list ───────────────────── */}
                            <FlashList
                                data={prospects}
                                keyExtractor={(p) => p.id}
                                ItemSeparatorComponent={ItemSeparator}
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
                            ListHeaderComponent={PickBoardHeader}
                            renderItem={({ item }) => (
                                <PickRow item={item} myMemberId={memberId} nextPick={nextPick} />
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
    player: RookieProspect
    isDone: boolean
    picking: boolean
    onPick: (player: RookieProspect) => void
}) {
    return (
        <MotionPressable
            style={styles.resultRow}
            onPress={isDone || picking ? undefined : () => onPick(player)}
            disabled={isDone || picking}
            pressedScale={0.985}
        >
            {player.nba_draft_number != null ? (
                <View style={styles.draftNumChip}>
                    <Text style={styles.draftNumText}>{player.nba_draft_number}</Text>
                </View>
            ) : (
                <View style={[styles.posChip, { backgroundColor: getPositionColor(player.position) }]}>
                    <Text style={styles.posChipText}>{player.position ?? '?'}</Text>
                </View>
            )}
            <View style={styles.resultInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.resultName}>{player.display_name}</Text>
                    {player.nba_draft_number != null && (
                        <View style={[styles.posChipXs, { backgroundColor: getPositionColor(player.position) }]}>
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
        </MotionPressable>
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
        <MotionView
            style={[
                styles.pickRow,
                isMe && styles.pickRowMe,
                isOnClock && styles.pickRowOnClock,
            ]}
            preset={isOnClock ? 'pop' : 'fade'}
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
                            { backgroundColor: getPositionColor(item.player.position) },
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
        </MotionView>
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
        borderBottomColor: palette.maple100,
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
    pickErrorBanner: {
        marginHorizontal: spacing.lg,
        marginBottom: spacing.sm,
        padding: spacing.md,
        backgroundColor: palette.red50,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: palette.red200,
    },
    pickErrorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },

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

    onClockText: { color: palette.green800, fontWeight: fontWeight.bold },
    meText: { color: colors.primary, fontWeight: fontWeight.bold },

    overflowOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'flex-end',
    },
    overflowCard: {
        backgroundColor: colors.bgCard,
        borderTopLeftRadius: radii['2xl'] ?? 24,
        borderTopRightRadius: radii['2xl'] ?? 24,
        padding: spacing['2xl'],
        paddingBottom: spacing['5xl'] ?? 48,
        gap: spacing.md,
    },
    overflowTitle: {
        fontSize: fontSize.xl,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    overflowBody: {
        fontSize: fontSize.md,
        color: colors.textSecondary,
        lineHeight: 22,
    },
    overflowBtn: {
        paddingVertical: 14,
        borderRadius: radii.xl,
        alignItems: 'center',
        marginTop: spacing.sm,
    },
    overflowBtnPrimary: {
        backgroundColor: colors.primary,
    },
    overflowBtnPrimaryText: {
        color: colors.textWhite,
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
    },
    overflowDropLabel: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textMuted,
        marginTop: spacing.md,
    },
    overflowDropList: {
        maxHeight: 220,
    },
    overflowDropRow: {
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    overflowDropName: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        color: palette.red900,
    },
    overflowDropPos: {
        fontSize: fontSize.xs,
        color: colors.textMuted,
    },
})

const PickBoardHeader = (
    <View style={[styles.pickRow, styles.pickHeader]}>
        <Text style={[styles.pickNum, styles.headerText]}>#</Text>
        <Text style={[styles.pickTeam, styles.headerText]}>Team</Text>
        <Text style={[styles.pickPlayer, styles.headerText]}>Player</Text>
    </View>
)
