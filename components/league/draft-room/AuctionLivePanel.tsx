import { StyleSheet, Text, TextInput, View } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { MotionPressable } from '@/components/Motion'
import { colors, fontFamily, fontSize, fontWeight, radii, spacing, tints } from '@/constants/tokens'
import { draftAgeLabel, draftEventTime, draftPlayerMeta } from '@/lib/draft-display'
import { playerHeadshotUrl } from '@/lib/format'
import type { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'

type Controller = ReturnType<typeof useAuctionDraftRoomController>

export function AuctionLivePanel({
    controller,
    memberId,
    compact,
}: {
    controller: Controller
    memberId?: string
    compact: boolean
}) {
    const state = controller.state
    const nomination = state?.openNomination
    if (!state || !nomination) return null
    const activeBids = state.activeBids
    const paused = state.draft.status === 'paused'
    const budget = memberId ? controller.budgetByMember.get(memberId) : undefined
    const leading = nomination.currentBidderId === memberId
    const leadingTeam = nomination.currentBidderId
        ? controller.budgetByMember.get(nomination.currentBidderId)?.teamName
        : undefined
    const urgent = !paused && controller.timeLeft > 0 && controller.timeLeft <= 10
    const minimumBid = Math.max(1, nomination.currentBidAmount + 1)
    const remainingBudget = budget?.remaining ?? Infinity
    const bidValue = parseInt(controller.bidText, 10)
    const bidValid = Number.isFinite(bidValue) && bidValue >= minimumBid && bidValue <= remainingBudget

    return <>
        <View style={[styles.card, compact && styles.cardCompact, urgent && styles.cardUrgent]}>
            <View style={[styles.liveLayout, compact && styles.liveLayoutCompact]}>
                <View style={styles.playerInfo}>
                    <Text style={styles.cardLabel}>ON THE BLOCK</Text>
                    <View style={styles.playerRow}>
                        <Avatar name={nomination.player?.displayName ?? 'Unknown Player'} color={colors.bgMuted}
                            uri={playerHeadshotUrl(nomination.player?.nbaId)} size={compact ? 44 : 64} />
                        <View style={styles.playerCopy}>
                            <Text style={styles.playerName} numberOfLines={compact ? 2 : undefined}>
                                {nomination.player?.displayName ?? 'Unknown Player'}
                            </Text>
                            <Text style={styles.playerMeta} numberOfLines={compact ? 1 : undefined}>{draftPlayerMeta([
                                nomination.player?.nbaTeam, nomination.player?.position, draftAgeLabel(nomination.player?.age),
                            ])}</Text>
                        </View>
                    </View>
                </View>
                <View style={[styles.bidPanel, compact && styles.bidPanelCompact]}>
                    <View style={styles.bidRow}>
                        <View style={styles.bidInfo}>
                            <Text style={[styles.bidAmount, leading && styles.bidAmountLeading]}>
                                {nomination.currentBidAmount > 0 ? `$${nomination.currentBidAmount}` : '—'}
                            </Text>
                            <Text style={[styles.bidLeader, leading && styles.bidLeaderLeading]}>
                                {nomination.currentBidderId == null ? 'No bids yet' : leading ? "You're leading" : `${leadingTeam} leads`}
                            </Text>
                        </View>
                        <View style={[styles.countdown, urgent && styles.countdownUrgent]}>
                            <Text style={[styles.countdownText, paused && styles.countdownTextPaused, urgent && styles.countdownTextUrgent]}>
                                {paused ? 'Paused' : `0:${String(controller.timeLeft).padStart(2, '0')}`}
                            </Text>
                        </View>
                    </View>
                    {!leading && (budget?.remaining ?? 0) >= 1 && !paused && controller.realtimeConnected ? <View style={styles.bidInputRow}>
                        <View style={styles.bidStepGroup}>
                            <MotionPressable style={styles.bidStep}
                                onPress={() => controller.setBidText((value) => String(Math.max(minimumBid, (parseInt(value, 10) || minimumBid) - 1)))}
                                accessibilityRole="button" accessibilityLabel="Decrease bid" hitSlop={8} pressedScale={0.88}>
                                <Text style={styles.bidStepText}>−</Text>
                            </MotionPressable>
                            <TextInput style={[styles.bidAmountInput, compact && styles.bidAmountInputCompact]}
                                value={controller.bidText} onChangeText={(value) => controller.setBidText(value.replace(/[^0-9]/g, ''))}
                                keyboardType="number-pad" selectTextOnFocus accessibilityLabel="Bid amount" />
                            <MotionPressable style={styles.bidStep}
                                onPress={() => controller.setBidText((value) => String(Math.min(
                                    remainingBudget, (parseInt(value, 10) || minimumBid - 1) + 1,
                                )))} accessibilityRole="button" accessibilityLabel="Increase bid" hitSlop={8} pressedScale={0.88}>
                                <Text style={styles.bidStepText}>+</Text>
                            </MotionPressable>
                        </View>
                        <MotionPressable style={[styles.bidButton, compact && styles.bidButtonCompact,
                            (controller.bidding || !bidValid) && styles.bidButtonDisabled]}
                            onPress={controller.handleBid} accessibilityRole="button"
                            accessibilityLabel={`Bid $${(bidValid ? bidValue : minimumBid).toLocaleString()}`}
                            disabled={controller.bidding || !bidValid || leading || controller.timeLeft === 0} pressedScale={0.965}>
                            <Text style={styles.bidButtonText}>Bid ${(bidValid ? bidValue : minimumBid).toLocaleString()}</Text>
                        </MotionPressable>
                    </View> : !paused && !controller.realtimeConnected ? (
                        <Text style={styles.presencePending}>Bidding unlocks after the live connection recovers.</Text>
                    ) : null}
                </View>
            </View>
            {nomination.nominatingMemberId === memberId && !paused && nomination.currentBidderId == null ?
                <MotionPressable style={styles.withdrawButton} onPress={controller.handleWithdraw}
                    disabled={controller.withdrawing} accessibilityRole="button" accessibilityLabel="Withdraw nomination" pressedScale={0.96}>
                    <Text style={styles.withdrawButtonText}>Withdraw nomination</Text>
                </MotionPressable> : null}
        </View>
        <View style={styles.historyPanel}>
            <View style={styles.historyHeader}>
                <Text style={styles.historyLabel}>Bid history</Text>
                <Text style={styles.historyCount}>{activeBids.length === 0
                    ? 'No bids' : `${activeBids.length} bid${activeBids.length === 1 ? '' : 's'}`}</Text>
            </View>
            {activeBids.length === 0
                ? <Text style={styles.historyEmpty}>No bids yet. Minimum bid is ${minimumBid}.</Text>
                : <View style={styles.historyItems}>{activeBids.slice(0, 6).map((bid, index) => {
                    const high = bid.memberId === nomination.currentBidderId && index === 0
                    return <View key={bid.id} style={styles.historyItem}>
                        <View style={[styles.orderPill, high && styles.orderPillHigh]}>
                            <Text style={[styles.orderText, high && styles.orderTextHigh]}>
                                {high ? 'High' : `#${activeBids.length - index}`}
                            </Text>
                        </View>
                        <View style={styles.historyInfo}>
                            <Text style={styles.historyTeam} numberOfLines={1}>{bid.teamName}</Text>
                            <Text style={styles.historyMeta}>{draftEventTime(bid.placedAt) ?? 'Just now'}</Text>
                        </View>
                        <Text style={[styles.historyAmount, high && styles.historyAmountHigh]}>${bid.amount}</Text>
                    </View>
                })}</View>}
        </View>
    </>
}

const styles = StyleSheet.create({
    card: { backgroundColor: colors.bgScreen, borderRadius: radii.md, borderCurve: 'continuous', borderWidth: 1,
        borderColor: colors.borderLight, padding: spacing.xl, gap: spacing.md },
    cardCompact: { padding: spacing.md, gap: spacing.sm },
    cardUrgent: { borderColor: colors.danger, borderWidth: 1.5, boxShadow: `0 0 0 3px ${tints.dangerFocusRing}` },
    cardLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder, letterSpacing: 0 },
    liveLayout: { gap: spacing.md },
    liveLayoutCompact: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    playerInfo: { flex: 1, minWidth: 0, gap: spacing.xs },
    playerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.xs },
    playerCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
    playerName: { fontSize: fontSize['2xl'], fontFamily: fontFamily.display, fontWeight: fontWeight.bold, color: colors.textPrimary },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    bidPanel: { gap: spacing.md },
    bidPanelCompact: { width: 318, maxWidth: '100%', gap: spacing.sm },
    bidRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    bidInfo: { gap: spacing.xs },
    bidAmount: { fontSize: fontSize['4xl'], fontFamily: fontFamily.display, fontWeight: fontWeight.bold,
        color: colors.primaryDark, letterSpacing: 0 },
    bidAmountLeading: { color: colors.successDark },
    bidLeader: { fontSize: fontSize.sm, color: colors.textMuted },
    bidLeaderLeading: { color: colors.successDark, fontWeight: fontWeight.bold, backgroundColor: colors.successLight,
        paddingHorizontal: spacing.md, paddingVertical: 2, borderRadius: radii.full, overflow: 'hidden', alignSelf: 'flex-start' },
    countdown: { width: 60, height: 60, borderRadius: 30, borderCurve: 'continuous', backgroundColor: colors.bgMuted,
        justifyContent: 'center', alignItems: 'center' },
    countdownUrgent: { backgroundColor: colors.dangerLight, borderWidth: 2, borderColor: colors.danger },
    countdownText: { fontSize: fontSize['2lg'], fontFamily: fontFamily.display, fontWeight: fontWeight.bold, color: colors.textSecondary },
    countdownTextPaused: { fontSize: fontSize.sm },
    countdownTextUrgent: { color: colors.dangerDark },
    bidInputRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
    bidStepGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexShrink: 0 },
    bidStep: { width: 44, height: 44, borderRadius: 22, borderCurve: 'continuous', backgroundColor: colors.bgMuted,
        justifyContent: 'center', alignItems: 'center' },
    bidStepText: { fontSize: fontSize.xl, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    bidAmountInput: { fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, width: 84, height: 44,
        textAlign: 'center', backgroundColor: colors.bgMuted, borderRadius: radii.md, borderCurve: 'continuous', paddingHorizontal: 10 },
    bidAmountInputCompact: { width: 70, minWidth: 70 },
    bidButton: { flex: 1, minWidth: 112, height: 44, backgroundColor: colors.primary, borderRadius: radii.md,
        borderCurve: 'continuous', justifyContent: 'center', alignItems: 'center' },
    bidButtonCompact: { minWidth: 96 },
    bidButtonDisabled: { opacity: 0.5 },
    bidButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    presencePending: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
    withdrawButton: { minHeight: 46, marginTop: spacing.md, alignItems: 'center', justifyContent: 'center',
        paddingVertical: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
    withdrawButtonText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
    historyPanel: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
        borderRadius: radii.md, borderCurve: 'continuous', backgroundColor: colors.bgMuted },
    historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    historyLabel: { fontSize: fontSize['2xs'], fontWeight: fontWeight.extrabold, letterSpacing: 0,
        textTransform: 'uppercase', color: colors.textMuted },
    historyCount: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    historyEmpty: { fontSize: fontSize.sm, color: colors.textSecondary },
    historyItems: { gap: spacing.xs },
    historyItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 38 },
    orderPill: { minWidth: 44, minHeight: 26, borderRadius: radii.full, borderCurve: 'continuous',
        backgroundColor: colors.bgScreen, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
    orderPillHigh: { backgroundColor: colors.successLight },
    orderText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    orderTextHigh: { color: colors.successDark },
    historyInfo: { flex: 1, minWidth: 0 },
    historyTeam: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
    historyMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
    historyAmount: { fontSize: fontSize.sm, fontFamily: fontFamily.display, fontWeight: fontWeight.bold, color: colors.primaryDark },
    historyAmountHigh: { color: colors.successDark },
})
