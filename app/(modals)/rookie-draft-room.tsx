import {
    View,
    Text,
    TextInput,
    StyleSheet,
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { type RookieProspect, type SnakePick } from '@/lib/rookieDraft'
import { getPositionColor } from "@/constants/positions"
import { colors, palette, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'
import { showSuccess } from '@/lib/alert'
import { countLabel, playerHeadshotUrl } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { DraftAdminBar } from '@/components/league/draft-room/DraftAdminBar'
import { DraftScreenHeader } from '@/components/league/draft-room/DraftScreenHeader'
import { useDraftAdminControls } from '@/components/league/draft-room/useDraftAdminControls'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'

export default function RookieDraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current, currentLeague, isCommissioner } = useLeagueContext()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    const myMemberId = current?.id

    const {
        state,
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
        refresh,
        handleTrimDrop,
        handlePick,
        handleCommissionerPick,
        resolveByTaxi,
        resolveByDrop,
    } = useRookieDraftRoomController({
        draftId,
        memberId: myMemberId,
        leagueId: currentLeague?.id,
        rosterSize: currentLeague?.roster_size ?? 20,
    })

    const { handleStopDraft, handleResetDraft, handlePauseDraft, handleResumeDraft } =
        useDraftAdminControls({
            draftId,
            refresh,
            onStopped: () => navigateBackToDraftList(state?.draft.isMock),
            onReset: () => showSuccess('Draft Reset', 'The rookie draft has been reset to the first pick.'),
            confirmCopy: {
                stop: 'This ends the rookie draft now. Players already drafted stay on their rosters and the league moves into the season. This cannot be undone.',
                reset: 'This clears every pick, returns all pick assets, and restarts the draft from the first selection. This cannot be undone.',
                pause: 'This freezes the pick clock until the commissioner resumes the draft.',
                resume: 'This restarts the draft clock and allows picks again.',
            },
        })

    function navigateBackToDraftList(isMock = false) {
        router.replace(isMock ? '/league?tab=mockRooms' : '/league?tab=draftBoard')
    }

    if (!state) {
        return (
            <>
                <Stack.Screen options={{ title: 'Rookie Draft', presentation: 'modal', headerShown: false }} />
                <SafeAreaView style={styles.container}>
                    <DraftScreenHeader title="Rookie Draft" onBack={() => navigateBackToDraftList()} />
                    <View style={styles.center}>
                        <Text style={styles.emptyText}>Draft not found.</Text>
                    </View>
                </SafeAreaView>
            </>
        )
    }

    const { draft, picks, nextPick } = state
    const isMyTurn = nextPick?.memberId === memberId
    const stopped = draft.status === 'cancelled'
    const isPaused = draft.status === 'paused'
    const isDone = draft.status === 'completed' || stopped
    const canCommissionerPick =
        isCommissioner && isPaused && draft.pauseReason === 'timer_expired_commissioner_pick' && !!nextPick
    const canUsePauseControl = !canCommissionerPick
    const pickTimerExpired =
        draft.status === 'in_progress' && !!nextPick?.timerExpiresAt && secondsLeft === 0
    const draftTitle = draft.isMock ? 'Mock Rookie Draft' : 'Rookie Draft'

    const isPending = draft.status === 'pending'
    const totalPicks = picks.length
    const madePicks = picks.filter((p) => p.player || p.skippedAt).length
    const currentRound = nextPick?.round
        ?? (state.orders.length > 0 ? Math.ceil(totalPicks / state.orders.length) : 1)

    return (
        <>
            <Stack.Screen options={{ title: draftTitle, presentation: 'modal', headerShown: false }} />

            {/* ── Roster overflow resolution modal (non-dismissable) ── */}
            <Modal visible={!!rosterOverflow} transparent animationType="slide">
                <View style={styles.overflowOverlay}>
                    <View style={styles.overflowCard}>
                        <Text style={styles.overflowTitle}>Roster Full</Text>
                        <Text style={styles.overflowBody}>
                            You drafted{' '}
                            <Text style={{ fontWeight: fontWeight.bold }}>{rosterOverflow?.newPlayerName}</Text>
                            {' '}but your active roster is over capacity. Resolve before continuing.
                        </Text>

                        {rosterOverflow?.taxiSlotsAvailable && (
                            <MotionPressable
                                style={[styles.overflowBtn, styles.overflowBtnPrimary]}
                                onPress={resolveByTaxi}
                                disabled={resolvingOverflow}
                                pressedScale={0.965}
                            >
                                <Text style={styles.overflowBtnPrimaryText}>
                                    Move {rosterOverflow?.newPlayerName} to Taxi Squad
                                </Text>
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
                                            <Avatar
                                                name={rp.players?.display_name ?? 'Player'}
                                                uri={playerHeadshotUrl(rp.players?.nba_id) ?? undefined}
                                                color={getPositionColor(rp.players?.position, colors.bgMuted)}
                                                textColor={colors.textSecondary}
                                                size={34}
                                            />
                                            <View style={styles.overflowDropInfo}>
                                                <Text style={styles.overflowDropName} numberOfLines={1}>
                                                    {rp.players?.display_name ?? 'Player'}
                                                </Text>
                                                <Text style={styles.overflowDropPos}>
                                                    {rp.players?.position ?? ''} · {rp.players?.nba_team ?? ''}
                                                </Text>
                                            </View>
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
                            <Text style={{ fontWeight: fontWeight.bold }}>{trimOverflow?.excess ?? 0} over</Text>
                            {' '}the limit. Drop {countLabel(trimOverflow?.excess ?? 0, 'player')} to continue.
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
                                    <Avatar
                                        name={rp.players?.display_name ?? 'Player'}
                                        uri={playerHeadshotUrl(rp.players?.nba_id) ?? undefined}
                                        color={getPositionColor(rp.players?.position, colors.bgMuted)}
                                        textColor={colors.textSecondary}
                                        size={34}
                                    />
                                    <View style={styles.overflowDropInfo}>
                                        <Text style={styles.overflowDropName} numberOfLines={1}>
                                            {rp.players?.display_name ?? 'Player'}
                                        </Text>
                                        <Text style={styles.overflowDropPos}>
                                            {rp.players?.position ?? ''} · {rp.players?.nba_team ?? ''}
                                        </Text>
                                    </View>
                                </MotionPressable>
                            ))}
                        </ScrollView>
                    </View>
                </View>
            </Modal>

            <SafeAreaView style={styles.container} edges={['bottom']}>
                <DraftScreenHeader title={draftTitle} onBack={() => navigateBackToDraftList(draft.isMock)} />
                <KeyboardAvoidingView
                    style={{ flex: 1 }}
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                >
                    <View style={[styles.topDraftPanel, compactLandscape && styles.topDraftPanelCompact]}>
                        {/* ── Status banner ────────────────────────── */}
                        <View
                            style={[
                                styles.banner,
                                compactLandscape && styles.bannerCompact,
                                isDone && styles.bannerDone,
                                isPaused && styles.bannerPaused,
                            ]}
                        >
                            {isDone ? (
                                <Text style={styles.bannerTitle} numberOfLines={compactLandscape ? 1 : undefined}>
                                    {stopped ? (draft.isMock ? 'Mock Draft Stopped' : 'Draft Stopped') : draft.isMock ? 'Mock Draft Complete' : 'Draft Complete'}
                                </Text>
                            ) : isPending ? (
                                <>
                                    <Text style={styles.bannerTitle} numberOfLines={compactLandscape ? 1 : undefined}>
                                        Waiting to Start
                                    </Text>
                                    <Text style={styles.bannerSub} numberOfLines={compactLandscape ? 1 : undefined}>
                                        {draft.isMock
                                            ? 'Picks unlock when the room creator starts the draft.'
                                            : 'Picks unlock when the commissioner starts the draft.'}
                                    </Text>
                                </>
                            ) : isPaused ? (
                                <>
                                    <Text style={styles.bannerTitle} numberOfLines={compactLandscape ? 1 : undefined}>
                                        {canCommissionerPick ? 'Commissioner Pick Needed' : 'Draft Paused'}
                                    </Text>
                                    <Text style={styles.bannerSub} numberOfLines={compactLandscape ? 1 : undefined}>
                                        {canCommissionerPick
                                            ? `Pick for ${nextPick?.teamName ?? 'the team on the clock'} to resume the draft.`
                                            : 'Commissioner will resume the pick clock.'}
                                    </Text>
                                </>
                            ) : (
                                <>
                                    <View style={styles.bannerRow}>
                                        <Text style={styles.bannerTitle} numberOfLines={1}>
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
                                        <Text style={styles.bannerSub} numberOfLines={compactLandscape ? 1 : undefined}>
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

                        {isCommissioner && !isDone ? (
                            <DraftAdminBar
                                isPaused={isPaused}
                                showPause={canUsePauseControl}
                                showLabel={!compactLandscape}
                                onPause={handlePauseDraft}
                                onResume={handleResumeDraft}
                                onReset={handleResetDraft}
                                onStop={handleStopDraft}
                                style={compactLandscape ? styles.adminBarCompact : styles.adminBarWide}
                            />
                        ) : null}
                    </View>

                    {/* ── Tab switcher ─────────────────────────── */}
                    <View style={styles.tabs}>
                        <MotionPressable
                            style={[styles.tab, activeTab === 'prospects' && styles.tabActive]}
                            onPress={() => setActiveTab('prospects')}
                            pressedScale={0.96}
                            accessibilityRole="button"
                            accessibilityLabel="Show prospects"
                        >
                            <Text style={[styles.tabText, activeTab === 'prospects' && styles.tabTextActive]}>
                                Prospects
                            </Text>
                        </MotionPressable>
                        <MotionPressable
                            style={[styles.tab, activeTab === 'board' && styles.tabActive]}
                            onPress={() => setActiveTab('board')}
                            pressedScale={0.96}
                            accessibilityRole="button"
                            accessibilityLabel="Show pick board"
                        >
                            <Text style={[styles.tabText, activeTab === 'board' && styles.tabTextActive]}>
                                Pick Board
                            </Text>
                        </MotionPressable>
                    </View>

                    {activeTab === 'prospects' ? (
                        <>
                            {/* ── Search bar ───────────────────────── */}
                            <View style={[styles.searchContainer, compactLandscape && styles.searchContainerCompact]}>
                                <TextInput
                                    style={styles.searchInput}
                                    placeholder="Search prospects…"
                                    placeholderTextColor={colors.textPlaceholder}
                                    value={query}
                                    onChangeText={setQuery}
                                    autoCorrect={false}
                                    returnKeyType="search"
                                    accessibilityLabel="Search prospects"
                                />
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
                                        isDone={isDone || isPending || pickTimerExpired || (isPaused && !canCommissionerPick)}
                                        picking={picking}
                                        onPick={canCommissionerPick ? handleCommissionerPick : handlePick}
                                        actionLabel={canCommissionerPick ? 'Commish Pick' : 'Pick'}
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
    actionLabel = 'Pick',
}: {
    player: RookieProspect
    isDone: boolean
    picking: boolean
    onPick: (player: RookieProspect) => void
    actionLabel?: string
}) {
    return (
        <MotionPressable
            style={styles.resultRow}
            onPress={isDone || picking ? undefined : () => onPick(player)}
            disabled={isDone || picking}
            pressedScale={0.985}
            accessibilityRole="button"
            accessibilityLabel={`${actionLabel} ${player.display_name}`}
        >
            <Avatar
                name={player.display_name}
                uri={playerHeadshotUrl(player.nba_id) ?? undefined}
                color={getPositionColor(player.position, colors.bgMuted)}
                textColor={colors.textSecondary}
                size={38}
            />
            <View style={styles.resultInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.resultName} numberOfLines={1}>{player.display_name}</Text>
                    {player.nba_draft_number != null && (
                        <View style={[styles.posChipXs, { backgroundColor: getPositionColor(player.position) }]}>
                            <Text style={styles.posChipXsText}>{player.position ?? '?'}</Text>
                        </View>
                    )}
                </View>
                <Text style={styles.resultTeam}>
                    {player.nba_draft_number != null ? `#${player.nba_draft_number} · ` : ''}{player.nba_team ?? 'FA'}
                </Text>
            </View>
            {!isDone && (
                <Text style={styles.pickBtn}>{actionLabel}</Text>
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
    const isSkipped = !!item.skippedAt
    const isOnClock = !item.player && !isSkipped && nextPick?.overallPick === item.overallPick

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
                    <Avatar
                        name={item.player.displayName}
                        uri={playerHeadshotUrl(item.player.nbaId) ?? undefined}
                        color={getPositionColor(item.player.position, colors.bgMuted)}
                        textColor={colors.textSecondary}
                        size={28}
                    />
                    <View>
                        <Text style={[styles.pickedName, isMe && styles.meText]} numberOfLines={1}>
                            {item.player.displayName}
                        </Text>
                        <Text style={styles.pickedTeam}>{item.player.nbaTeam ?? 'FA'}</Text>
                    </View>
                </View>
            ) : isSkipped ? (
                <Text style={styles.pickSkipped}>Skipped</Text>
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

    topDraftPanel: {},
    topDraftPanelCompact: {
        minHeight: 54,
        flexDirection: 'row',
        alignItems: 'stretch',
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },

    banner: {
        backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: palette.maple100,
        paddingHorizontal: spacing['2xl'],
        paddingVertical: 14,
        gap: spacing.xs,
    },
    bannerCompact: {
        flex: 1,
        minWidth: 0,
        minHeight: 54,
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderBottomWidth: 0,
    },
    bannerDone: { backgroundColor: palette.green50, borderBottomColor: palette.green200 },
    bannerPaused: { backgroundColor: colors.bgSubtle, borderBottomColor: colors.border },
    adminBarWide: { paddingHorizontal: spacing['2xl'] },
    adminBarCompact: {
        width: 252,
        minHeight: 54,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderBottomWidth: 0,
        borderLeftWidth: 1,
        borderLeftColor: colors.borderLight,
    },
    bannerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    bannerTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    bannerClock: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textMuted },
    bannerClockUrgent: { color: colors.danger },
    bannerSub: { fontSize: fontSize.md, color: colors.textSecondary },
    bannerMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },

    tabs: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    tab: {
        flex: 1,
        minHeight: 46,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabActive: {
        borderBottomWidth: 2,
        borderBottomColor: colors.primary,
    },
    tabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    tabTextActive: { color: colors.primaryDark },

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
    searchContainerCompact: {
        minHeight: 44,
        marginHorizontal: spacing.xs,
        marginTop: spacing.xxs,
        marginBottom: 0,
        paddingVertical: 0,
        borderRadius: radii.md,
    },
    searchInput: { flex: 1, height: 44, fontSize: fontSize.lg, color: colors.textPrimary },
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
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.xs,
        gap: 10,
    },
    resultInfo: { flex: 1 },
    resultName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    resultTeam: { fontSize: fontSize['2sm'], color: colors.textMuted },
    pickBtn: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primaryDark },

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
        borderRadius: radii.xs,
        borderCurve: 'continuous' as const,
    },
    posChipXsText: { color: colors.textWhite, fontSize: fontSize['2xs'], fontWeight: fontWeight.bold },

    posChipSm: {
        width: 28,
        height: 28,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    posChipSmText: { color: colors.textWhite, fontSize: fontSize['2xs'], fontWeight: fontWeight.bold },

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
    pickSkipped: { flex: 1, fontSize: fontSize.sm, color: colors.textMuted, fontWeight: fontWeight.semibold },

    pickPlayerCell: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    pickedName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    pickedTeam: { fontSize: fontSize.xs, color: colors.textMuted },

    onClockText: { color: palette.green800, fontWeight: fontWeight.bold },
    meText: { color: colors.primaryDark, fontWeight: fontWeight.bold },

    overflowOverlay: {
        flex: 1,
        backgroundColor: scrim,
        justifyContent: 'flex-end',
    },
    overflowCard: {
        backgroundColor: colors.bgCard,
        borderTopLeftRadius: radii['2xl'],
        borderTopRightRadius: radii['2xl'],
        padding: spacing['2xl'],
        paddingBottom: spacing['5xl'],
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
        minHeight: 46,
        justifyContent: 'center',
        borderRadius: radii.md,
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
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    overflowDropInfo: { flex: 1, minWidth: 0 },
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
