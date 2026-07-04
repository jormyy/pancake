import {
    View,
    Text,
    TextInput,
    StyleSheet,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    useWindowDimensions,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { NOMINATION_ORDER_MODE_LABELS } from '@/lib/draft'
import { alpha, breakpoints, colors, fontFamily, fontSize, fontWeight, layout, palette, radii, spacing } from '@/constants/tokens'
import { getPositionColor } from '@/constants/positions'
import { Avatar } from '@/components/Avatar'
import { playerHeadshotUrl } from '@/lib/format'
import { MotionPressable, MotionView } from '@/components/Motion'
import { DraftAdminBar } from '@/components/league/draft-room/DraftAdminBar'
import { DraftScreenHeader } from '@/components/league/draft-room/DraftScreenHeader'
import { useDraftAdminControls } from '@/components/league/draft-room/useDraftAdminControls'
import { useAuctionDraftRoomController, type DraftTab } from '@/hooks/useAuctionDraftRoomController'

function ageLabel(age: number | null | undefined): string | null {
    if (age == null || !Number.isFinite(age)) return null
    return `Age ${Number(age).toFixed(1)}`
}

function playerMeta(parts: (string | null | undefined)[]): string {
    return parts.filter(Boolean).join(' · ') || '—'
}

export default function DraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current, isCommissioner } = useLeagueContext()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    // Two-column auction floor on desktop: block card + bid controls left,
    // budgets/history right. Compact landscape keeps its own dense layout.
    const isDesktop = width >= breakpoints.desktop && !compactLandscape

    const myMemberId = current?.id

    const {
        state,
        tab,
        setTab,
        loadError,
        bidText,
        setBidText,
        bidding,
        withdrawing,
        nominating,
        setNominating,
        searchQuery,
        setSearchQuery,
        searchResults,
        searchLoading,
        searchError,
        submittingNom,
        timeLeft,
        closedNominations,
        budgetByMember,
        wonCountByMember,
        refresh,
        handleBid,
        handleWithdraw,
        handleNominate,
        cancelNominating,
    } = useAuctionDraftRoomController({ draftId, memberId: myMemberId })

    const { handleStopDraft, handleResetDraft, handlePauseDraft, handleResumeDraft } =
        useDraftAdminControls({
            draftId,
            refresh,
            onStopped: () => navigateBackToDraftList(state?.draft.isMock),
            confirmCopy: {
                stop: 'This ends the draft now. Players already drafted stay on their rosters and the league moves into the season. This cannot be undone.',
                reset: 'This wipes every pick, bid, and budget and restarts the draft from scratch. This cannot be undone.',
                pause: 'This freezes nominations and bidding until the commissioner resumes the draft.',
                resume: 'This reopens the draft clock and lets managers nominate and bid again.',
            },
        })

    function navigateBackToDraftList(isMock = false) {
        router.replace(isMock ? '/league?tab=mockRooms' : '/league?tab=auctions')
    }

    if (!state) {
        const hasLoadError = loadError != null
        return (
            <>
                <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
                <SafeAreaView style={styles.container} edges={['bottom']}>
                    <DraftScreenHeader title="Auction Draft" onBack={() => navigateBackToDraftList()} />
                    <View style={styles.draftEndedContainer}>
                        <Text style={styles.draftEndedTitle}>{hasLoadError ? 'Could not load draft' : 'Draft not found'}</Text>
                        <Text style={styles.draftEndedSub}>
                            {hasLoadError ? loadError : 'This draft may have ended or no longer exists.'}
                        </Text>
                        <MotionPressable
                            style={styles.nominateButton}
                            onPress={hasLoadError ? refresh : () => navigateBackToDraftList()}
                            pressedScale={0.96}
                        >
                            <Text style={styles.nominateButtonText}>{hasLoadError ? 'Try Again' : 'Back to League'}</Text>
                        </MotionPressable>
                    </View>
                </SafeAreaView>
            </>
        )
    }

    const { draft, order, budgets, openNomination, currentNominatorMemberId } = state
    const isMyTurn = currentNominatorMemberId === myMemberId
    const isPaused = draft.status === 'paused'
    const currentNominatorTeam =
        order.find((o) => o.memberId === currentNominatorMemberId)?.teamName ?? 'Unknown'

    const myBudget = myMemberId ? budgetByMember.get(myMemberId) : undefined
    const iAmLeading = openNomination?.currentBidderId === myMemberId
    const leadingTeam = openNomination?.currentBidderId
        ? budgetByMember.get(openNomination.currentBidderId)?.teamName
        : undefined

    const iAmBankrupt = (myBudget?.remaining ?? 0) < 1
    // Hot final seconds — the clock and the nomination card shift to the danger
    // accent together so the whole block reads as "going once, going twice".
    // timeLeft > 0 so a nomination with no countdown never shows as permanently
    // urgent; the 1-10s window is the real urgency band.
    const clockUrgent = !isPaused && openNomination != null && timeLeft > 0 && timeLeft <= 10
    // Min bid is current + 1, floored at 1
    const minBid = Math.max(1, (openNomination?.currentBidAmount ?? 0) + 1)
    const remainingBudget = myBudget?.remaining ?? Infinity
    const bidValue = parseInt(bidText, 10) // NaN while the field is empty/partial
    const bidValid = !isNaN(bidValue) && bidValue >= minBid && bidValue <= remainingBudget
    const draftTitle = draft.isMock ? 'Mock Auction Draft' : 'Auction Draft'

    if (draft.status === 'completed' || draft.status === 'cancelled') {
        const stopped = draft.status === 'cancelled'
        return (
            <>
                <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
                <SafeAreaView style={styles.container} edges={['bottom']}>
                    <DraftScreenHeader title={draftTitle} onBack={() => navigateBackToDraftList(draft.isMock)} />
                    <View style={styles.draftEndedContainer}>
                        <Text style={styles.draftEndedTitle}>{stopped ? 'Draft Stopped' : 'Draft Complete'}</Text>
                        <Text style={styles.draftEndedSub}>
                            {stopped
                                ? 'The commissioner ended the draft. Players already drafted are on their rosters; everyone else is a free agent.'
                                : 'All teams are out of budget. Remaining players are free agents.'}
                        </Text>
                        <MotionPressable
                            style={styles.nominateButton}
                            onPress={() => navigateBackToDraftList(draft.isMock)}
                            pressedScale={0.96}
                        >
                            <Text style={styles.nominateButtonText}>Back to League</Text>
                        </MotionPressable>
                    </View>
                </SafeAreaView>
            </>
        )
    }

    return (
        <>
            <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
            <DraftScreenHeader title={draftTitle} onBack={() => navigateBackToDraftList(draft.isMock)}>
                {myBudget?.remaining != null ? (
                    <View style={styles.budgetChip}>
                        <Text style={styles.budgetChipText}>${myBudget.remaining} left</Text>
                    </View>
                ) : null}
            </DraftScreenHeader>

            {isCommissioner ? (
                <DraftAdminBar
                    isPaused={isPaused}
                    onPause={handlePauseDraft}
                    onResume={handleResumeDraft}
                    onReset={handleResetDraft}
                    onStop={handleStopDraft}
                />
            ) : null}

            {loadError ? (
                <Pressable style={styles.refreshWarning} onPress={refresh}>
                    <Text style={styles.refreshWarningText}>Live draft refresh failed. Tap to retry.</Text>
                </Pressable>
            ) : null}

            <KeyboardAvoidingView
                style={styles.keyboard}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={[
                    styles.scrollContent,
                    compactLandscape && styles.scrollContentCompact,
                    isDesktop && styles.scrollContentDesktop,
                ]}
                keyboardShouldPersistTaps="handled"
            >
                <View style={[styles.columns, compactLandscape && styles.columnsCompact, isDesktop && styles.columnsDesktop]}>
                    <View style={[styles.column, compactLandscape && styles.columnCompact, isDesktop && styles.columnMainDesktop]}>
                        {/* Nomination on the clock */}
                        {openNomination ? (
                            <View style={[styles.card, compactLandscape && styles.cardCompact, clockUrgent && styles.cardUrgent]}>
                                <View style={[styles.liveAuctionLayout, compactLandscape && styles.liveAuctionLayoutCompact]}>
                                    <View style={styles.livePlayerInfo}>
                                        <Text style={styles.cardLabel}>ON THE BLOCK</Text>
                                        {/* Headshot when the player has an nba_id;
                                            position-colored initials otherwise. */}
                                        <View style={styles.livePlayerRow}>
                                            <Avatar
                                                name={openNomination.player?.displayName ?? 'Unknown Player'}
                                                color={getPositionColor(openNomination.player?.position, colors.primary)}
                                                uri={playerHeadshotUrl(openNomination.player?.nbaId)}
                                                size={compactLandscape ? 44 : 64}
                                            />
                                            <View style={styles.livePlayerText}>
                                                <Text style={styles.playerName} numberOfLines={compactLandscape ? 2 : undefined}>
                                                    {openNomination.player?.displayName ?? 'Unknown Player'}
                                                </Text>
                                                <Text style={styles.playerMeta} numberOfLines={compactLandscape ? 1 : undefined}>
                                                    {playerMeta([
                                                        openNomination.player?.nbaTeam,
                                                        openNomination.player?.position,
                                                        ageLabel(openNomination.player?.age),
                                                    ])}
                                                </Text>
                                            </View>
                                        </View>
                                    </View>

                                    <View style={[styles.liveBidPanel, compactLandscape && styles.liveBidPanelCompact]}>
                                        <View style={[styles.bidRow, compactLandscape && styles.bidRowCompact]}>
                                            <View style={styles.bidInfo}>
                                                <Text style={[styles.bidAmount, iAmLeading && styles.bidAmountLeading]}>
                                                    {openNomination.currentBidAmount > 0
                                                        ? `$${openNomination.currentBidAmount}`
                                                        : '—'}
                                                </Text>
                                                <Text style={[styles.bidLeader, iAmLeading && styles.bidLeaderLeading]}>
                                                    {openNomination.currentBidderId == null
                                                        ? 'No bids yet'
                                                        : iAmLeading
                                                          ? "You're leading"
                                                          : `${leadingTeam} leads`}
                                                </Text>
                                            </View>
                                            <View style={[styles.countdown, clockUrgent && styles.countdownUrgent]}>
                                                <Text
                                                    style={[
                                                        styles.countdownText,
                                                        isPaused && styles.countdownTextPaused,
                                                        clockUrgent && styles.countdownTextUrgent,
                                                    ]}
                                                >
                                                    {isPaused ? 'Paused' : `0:${String(timeLeft).padStart(2, '0')}`}
                                                </Text>
                                            </View>
                                        </View>

                                        {!iAmLeading && !iAmBankrupt && !isPaused && (
                                            <View style={[styles.bidInputRow, compactLandscape && styles.bidInputRowCompact]}>
                                                {/* Non-wrapping group: the row may wrap between this
                                                    group and the Bid button, never inside −/amount/+. */}
                                                <View style={styles.bidStepGroup}>
                                                    <MotionPressable
                                                        style={styles.bidStep}
                                                        onPress={() =>
                                                            setBidText((t) => String(Math.max(minBid, (parseInt(t, 10) || minBid) - 1)))
                                                        }
                                                        accessibilityRole="button"
                                                        accessibilityLabel="Decrease bid"
                                                        hitSlop={8}
                                                        pressedScale={0.88}
                                                    >
                                                        <Text style={styles.bidStepText}>−</Text>
                                                    </MotionPressable>
                                                    <TextInput
                                                        style={[styles.bidAmountInput, compactLandscape && styles.bidAmountInputCompact]}
                                                        value={bidText}
                                                        onChangeText={(v) => setBidText(v.replace(/[^0-9]/g, ''))}
                                                        keyboardType="number-pad"
                                                        selectTextOnFocus
                                                        accessibilityLabel="Bid amount"
                                                    />
                                                    <MotionPressable
                                                        style={styles.bidStep}
                                                        onPress={() =>
                                                            setBidText((t) =>
                                                                String(Math.min(remainingBudget, (parseInt(t, 10) || minBid - 1) + 1)),
                                                            )
                                                        }
                                                        accessibilityRole="button"
                                                        accessibilityLabel="Increase bid"
                                                        hitSlop={8}
                                                        pressedScale={0.88}
                                                    >
                                                        <Text style={styles.bidStepText}>+</Text>
                                                    </MotionPressable>
                                                </View>
                                                <MotionPressable
                                                    style={[
                                                        styles.bidButton,
                                                        compactLandscape && styles.bidButtonCompact,
                                                        (bidding || !bidValid) && styles.bidButtonDisabled,
                                                    ]}
                                                    onPress={handleBid}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Bid $${(bidValid ? bidValue : minBid).toLocaleString()}`}
                                                    disabled={bidding || !bidValid || iAmLeading || timeLeft === 0}
                                                    pressedScale={0.965}
                                                >
                                                    <Text style={styles.bidButtonText}>
                                                        Bid ${(bidValid ? bidValue : minBid).toLocaleString()}
                                                    </Text>
                                                </MotionPressable>
                                            </View>
                                        )}
                                    </View>
                                </View>

                                {openNomination.nominatingMemberId === myMemberId &&
                                    !isPaused &&
                                    openNomination.currentBidderId == null && (
                                        <MotionPressable
                                            style={styles.withdrawButton}
                                            onPress={handleWithdraw}
                                            disabled={withdrawing}
                                            accessibilityRole="button"
                                            accessibilityLabel="Withdraw nomination"
                                            pressedScale={0.96}
                                        >
                                            <Text style={styles.withdrawButtonText}>Withdraw nomination</Text>
                                        </MotionPressable>
                                    )}
                            </View>
                        ) : (
                            /* No open nomination — show whose turn it is */
                            <View style={[styles.card, compactLandscape && styles.cardCompact]}>
                                {isPaused ? (
                                    <View style={styles.waitingRow}>
                                        <Text style={styles.waitingTeam}>Draft paused</Text>
                                        <Text style={styles.waitingText}>Commissioner will resume the clock.</Text>
                                    </View>
                                ) : isMyTurn ? (
                                    <>
                                        <Text style={styles.yourTurnBanner}>Your turn to nominate!</Text>
                                        <Text style={styles.nominationModeHint}>
                                            Nomination order: {NOMINATION_ORDER_MODE_LABELS[draft.nominationOrderMode]}
                                        </Text>
                                        {nominating ? (
                                            <>
                                                <TextInput
                                                    style={styles.searchInput}
                                                    value={searchQuery}
                                                    onChangeText={setSearchQuery}
                                                    placeholder="Search player name..."
                                                    autoFocus
                                                    accessibilityLabel="Search player name"
                                                />
                                                <FlashList
                                                    data={searchResults}
                                                    keyExtractor={(p) => p.id}
                                                    scrollEnabled={false}
                                                    renderItem={({ item }) => (
                                                        <MotionPressable
                                                            style={styles.playerResult}
                                                            onPress={() =>
                                                                handleNominate(item.id)
                                                            }
                                                            disabled={submittingNom}
                                                            pressedScale={0.975}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={`Nominate ${item.display_name ?? 'player'}`}
                                                        >
                                                            <View style={styles.flex1}>
                                                                <Text style={styles.playerResultName}>
                                                                    {item.display_name}
                                                                </Text>
                                                                <Text style={styles.playerResultMeta}>
                                                                    {playerMeta([
                                                                        item.dynasty_rank != null ? `#${item.dynasty_rank}` : null,
                                                                        item.nba_team,
                                                                        item.position,
                                                                        ageLabel(item.age),
                                                                    ])}
                                                                </Text>
                                                            </View>
                                                            <Text style={styles.nominateLabel}>
                                                                Nominate
                                                            </Text>
                                                        </MotionPressable>
                                                    )}
                                                    ListEmptyComponent={
                                                        searchError ? (
                                                            <Text style={styles.emptySearch}>
                                                                Search failed. Keep typing or try again.
                                                            </Text>
                                                        ) : searchQuery.length > 0 && !searchLoading ? (
                                                            <Text style={styles.emptySearch}>
                                                                No players found
                                                            </Text>
                                                        ) : null
                                                    }
                                                />
                                                <MotionPressable
                                                    style={styles.cancelNomButton}
                                                    onPress={cancelNominating}
                                                    pressedScale={0.94}
                                                    accessibilityRole="button"
                                                    accessibilityLabel="Cancel nomination search"
                                                >
                                                    <Text style={styles.cancelNomText}>Cancel</Text>
                                                </MotionPressable>
                                            </>
                                        ) : (
                                            <MotionPressable
                                                style={styles.nominateButton}
                                                onPress={() => setNominating(true)}
                                                pressedScale={0.965}
                                                accessibilityRole="button"
                                                accessibilityLabel="Search and nominate a player"
                                            >
                                                <Text style={styles.nominateButtonText}>
                                                    Search & Nominate a Player
                                                </Text>
                                            </MotionPressable>
                                        )}
                                    </>
                                ) : (
                                    <View style={styles.waitingRow}>
                                        <Text style={styles.waitingText}>Waiting for</Text>
                                        <Text style={styles.waitingTeam}>{currentNominatorTeam}</Text>
                                        <Text style={styles.waitingText}>to nominate...</Text>
                                    </View>
                                )}
                            </View>
                        )}

                        {/* Live ticker — the last few hammer results, so the room feels
                            like an auction floor. Honest data only: these are real
                            closed nominations from state (per-bid history isn't held
                            client-side). */}
                        {closedNominations.length > 0 ? (
                            <View style={styles.activityStrip}>
                                <Text style={styles.activityLabel}>Recent activity</Text>
                                <View style={styles.activityItems}>
                                    {closedNominations.slice(0, 3).map((n) => {
                                        const winnerTeam = n.winningMemberId
                                            ? budgetByMember.get(n.winningMemberId)?.teamName
                                            : undefined
                                        return (
                                            <View key={n.id} style={styles.activityItem}>
                                                <Text style={styles.activityText} numberOfLines={1}>
                                                    {n.status === 'sold'
                                                        ? `${winnerTeam ?? 'Unknown'} won ${n.player?.displayName ?? 'Unknown'}`
                                                        : n.status === 'withdrawn'
                                                          ? `${n.player?.displayName ?? 'Unknown'} withdrawn`
                                                          : `${n.player?.displayName ?? 'Unknown'} went unsold`}
                                                </Text>
                                                {n.status === 'sold' ? (
                                                    <Text style={styles.activityPrice}>${n.finalPrice}</Text>
                                                ) : null}
                                            </View>
                                        )
                                    })}
                                </View>
                            </View>
                        ) : null}

                    </View>

                    <View style={[styles.column, compactLandscape && styles.columnCompact, isDesktop && styles.columnSideDesktop]}>
                        {/* Tab switcher */}
                        <View style={styles.tabRow}>
                            {(['budgets', 'history'] as DraftTab[]).map((t) => (
                                <MotionPressable
                                    key={t}
                                    style={[styles.tabChip, tab === t && styles.tabChipActive]}
                                    onPress={() => setTab(t)}
                                    pressedScale={0.94}
                                >
                                    <Text
                                        style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}
                                    >
                                        {t === 'budgets'
                                            ? 'Budgets'
                                            : `History (${closedNominations.length})`}
                                    </Text>
                                </MotionPressable>
                            ))}
                        </View>

                        {tab === 'budgets' ? (
                            <MotionView style={[styles.card, compactLandscape && styles.cardCompact]} preset="rise" delay={80}>
                                {budgets
                                    .slice()
                                    .sort((a, b) => b.remaining - a.remaining)
                                    .map((b, i) => (
                                        <View
                                            key={b.memberId}
                                            style={[styles.budgetRow, i > 0 && styles.budgetDivider]}
                                        >
                                            <Text
                                                style={[
                                                    styles.budgetTeam,
                                                    b.memberId === myMemberId && styles.meAccent,
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {b.teamName}
                                                {b.memberId === myMemberId ? ' (you)' : ''}
                                            </Text>
                                            <Text style={styles.budgetWon}>
                                                {wonCountByMember.get(b.memberId) ?? 0} won
                                            </Text>
                                            <Text
                                                style={[
                                                    styles.budgetAmount,
                                                    b.memberId === myMemberId && styles.meAccent,
                                                ]}
                                            >
                                                ${b.remaining}
                                            </Text>
                                        </View>
                                    ))}
                            </MotionView>
                        ) : closedNominations.length === 0 ? (
                            <View style={styles.empty}>
                                <Text style={styles.emptyText}>No players sold yet.</Text>
                            </View>
                        ) : (
                            <MotionView style={[styles.card, compactLandscape && styles.cardCompact]} preset="rise" delay={80}>
                                {closedNominations.map((n, i) => {
                                    const winnerTeam = n.winningMemberId
                                        ? budgetByMember.get(n.winningMemberId)?.teamName
                                        : undefined
                                    return (
                                        <View
                                            key={n.id}
                                            style={[styles.historyRow, i > 0 && styles.budgetDivider]}
                                        >
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.historyPlayer}>
                                                    {n.player?.displayName ?? 'Unknown'}
                                                </Text>
                                                <Text style={styles.historyMeta}>
                                                    {playerMeta([
                                                        n.status === 'sold' ? (winnerTeam ?? '—') : 'No bid',
                                                        ageLabel(n.player?.age),
                                                    ])}
                                                </Text>
                                            </View>
                                            {n.status === 'sold' && (
                                                <Text style={styles.historyPrice}>${n.finalPrice}</Text>
                                            )}
                                            {n.status === 'no_bid' && (
                                                <Text style={styles.historyNoBid}>FA</Text>
                                            )}
                                        </View>
                                    )
                                })}
                            </MotionView>
                        )}
                    </View>
                </View>
            </ScrollView>
            </KeyboardAvoidingView>
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    flex1: { flex: 1 },
    keyboard: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: spacing.xl, paddingBottom: spacing['3xl'], gap: spacing.lg, width: '100%', maxWidth: 760, alignSelf: 'center' },
    scrollContentCompact: {
        paddingHorizontal: spacing.md,
        paddingTop: spacing.md,
        paddingBottom: spacing['4xl'],
        gap: spacing.sm,
    },
    // Wide screens open up to the shared content width so the auction floor
    // fills the canvas instead of a narrow centered strip.
    scrollContentDesktop: {
        maxWidth: layout.contentMaxWidth,
        paddingHorizontal: spacing['3xl'],
        paddingTop: spacing['3xl'],
    },

    // Single column on phones; block card + activity left, budgets/history
    // right once `isDesktop` flips the outer wrapper to a row.
    columns: { gap: spacing.lg },
    columnsCompact: { gap: spacing.sm },
    columnsDesktop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xl },
    column: { gap: spacing.lg },
    columnCompact: { gap: spacing.sm },
    columnMainDesktop: { flex: 3, minWidth: 0 },
    columnSideDesktop: { flex: 2, minWidth: 0 },

    budgetChip: {
        backgroundColor: colors.primaryLight,
        minHeight: 36,
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    budgetChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    refreshWarning: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.sm,
        backgroundColor: colors.dangerLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.danger,
        alignItems: 'center',
    },
    refreshWarningText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dangerDark },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.xl,
        gap: spacing.md,
    },
    cardCompact: {
        padding: spacing.md,
        gap: spacing.sm,
    },
    cardLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder, letterSpacing: 0 },

    playerName: {
        fontSize: fontSize['2xl'],
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },

    liveAuctionLayout: { gap: spacing.md },
    liveAuctionLayoutCompact: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md,
    },
    livePlayerInfo: { flex: 1, minWidth: 0, gap: spacing.xs },
    livePlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.xs },
    livePlayerText: { flex: 1, minWidth: 0, gap: spacing.xs },
    liveBidPanel: { gap: spacing.md },
    liveBidPanelCompact: { width: 318, maxWidth: '100%', gap: spacing.sm },

    bidRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: spacing.xs,
    },
    bidRowCompact: { marginTop: 0 },
    bidInfo: { gap: spacing.xs },
    bidAmount: {
        fontSize: fontSize['4xl'],
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.primaryDark,
        letterSpacing: -0.5,
    },
    bidAmountLeading: { color: colors.successDark },
    bidLeader: { fontSize: fontSize.sm, color: colors.textMuted },
    bidLeaderLeading: {
        color: colors.successDark,
        fontWeight: fontWeight.bold,
        backgroundColor: colors.successLight,
        paddingHorizontal: spacing.md,
        paddingVertical: 2,
        borderRadius: radii.full,
        overflow: 'hidden' as const,
        alignSelf: 'flex-start' as const,
    },

    countdown: {
        width: 60,
        height: 60,
        borderRadius: 30,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    countdownUrgent: {
        backgroundColor: colors.dangerLight,
        borderWidth: 2,
        borderColor: colors.danger,
    },
    countdownText: {
        fontSize: 18,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    countdownTextPaused: { fontSize: fontSize.sm },
    countdownTextUrgent: { color: colors.dangerDark },
    cardUrgent: {
        borderColor: colors.danger,
        borderWidth: 1.5,
        boxShadow: `0 0 0 3px ${alpha(palette.red500, 0.14)}`,
    },

    activityStrip: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    activityLabel: {
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 0.6,
        textTransform: 'uppercase' as const,
        color: colors.textMuted,
    },
    activityItems: {
        flex: 1,
        minWidth: 200,
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: spacing.xl,
        rowGap: spacing.xxs,
    },
    activityItem: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs, maxWidth: '100%' },
    activityText: { fontSize: fontSize.sm, color: colors.textSecondary, flexShrink: 1 },
    activityPrice: {
        fontSize: fontSize.sm,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.primaryDark,
    },

    bidInputRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
    // flexShrink 0 keeps the −/amount/+ trio intact; the Bid button (flex:1) wraps
    // to its own line at narrow widths instead of pushing "+" off the card edge.
    bidStepGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexShrink: 0 },
    bidInputRowCompact: { gap: spacing.sm, marginTop: 0 },
    bidStep: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    bidStepText: { fontSize: 20, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    bidAmountInput: {
        fontSize: 18,
        fontWeight: fontWeight.extrabold,
        width: 84,
        height: 44,
        textAlign: 'center',
        backgroundColor: colors.bgMuted,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 10,
        paddingVertical: spacing.sm,
    },
    bidAmountInputCompact: { width: 70, minWidth: 70 },
    bidButton: {
        flex: 1,
        minWidth: 112,
        height: 44,
        backgroundColor: colors.primary,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    bidButtonCompact: { minWidth: 96 },
    bidButtonDisabled: { opacity: 0.5 },
    bidButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    yourTurnBanner: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textAlign: 'center' },
    nominationModeHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs },
    nominateButton: {
        marginTop: spacing.xs,
        height: 48,
        backgroundColor: colors.primary,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    nominateButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    searchInput: {
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        fontSize: 15,
        marginTop: spacing.xs,
    },

    playerResult: {
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
        gap: spacing.md,
    },
    playerResultName: { fontSize: 15, fontWeight: fontWeight.semibold },
    playerResultMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    nominateLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    emptySearch: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginTop: spacing.md },
    cancelNomButton: { minHeight: 44, marginTop: spacing.sm, alignItems: 'center', justifyContent: 'center' },
    cancelNomText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
    withdrawButton: {
        minHeight: 46,
        marginTop: spacing.md,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.border,
    },
    withdrawButtonText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },

    waitingRow: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.md },
    waitingText: { fontSize: fontSize.md, color: colors.textMuted },
    waitingTeam: { fontSize: 18, fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    tabRow: { flexDirection: 'row', gap: spacing.md },
    tabChip: {
        flex: 1,
        minHeight: 44,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 14,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },

    budgetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
    budgetDivider: { borderTopWidth: 1, borderTopColor: colors.separator },
    budgetTeam: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    budgetAmount: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    budgetWon: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted, marginRight: spacing.lg },
    meAccent: { color: colors.primaryDark },

    historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
    historyPlayer: { fontSize: fontSize.md, fontWeight: fontWeight.semibold },
    historyMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    historyPrice: { fontSize: 15, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    historyNoBid: {
        fontSize: 12,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.md,
        paddingVertical: 3,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
    },

    empty: { alignItems: 'center', paddingVertical: spacing['3xl'] },
    emptyText: { fontSize: fontSize.sm, color: colors.textPlaceholder },

    draftEndedContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing['4xl'], gap: spacing.lg },
    draftEndedTitle: { fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    draftEndedSub: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
})
