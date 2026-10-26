import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { TaxiAcquisitionChoice } from '@/components/TaxiAcquisitionChoice'

import { MotionPressable } from '@/components/Motion'
import { colors, controlSize, fontFamily, fontSize, fontWeight, radii, spacing, textStyles, tints } from '@/constants/tokens'
import { draftAgeLabel, draftEventTime } from '@/lib/draft-display'
import { formatCountdown } from '@/lib/format'
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
    const leaderText = nomination.currentBidderId == null
        ? 'No bids yet'
        : leading ? "You're leading" : `${leadingTeam} leads`
    const bidLabel = activeBids.length === 0
        ? 'No bids'
        : `${activeBids.length} bid${activeBids.length === 1 ? '' : 's'}`
    const liveStateLabel = `${nomination.currentBidAmount > 0 ? `$${nomination.currentBidAmount}` : '—'} | ${leaderText} | ${bidLabel}`
    const urgent = !paused && controller.timeLeft > 0 && controller.timeLeft <= 10
    const minimumBid = Math.max(1, nomination.currentBidAmount + 1)
    const remainingBudget = budget?.remaining ?? Infinity
    const bidValue = parseInt(controller.bidText, 10)
    const bidValid = Number.isFinite(bidValue) && bidValue >= minimumBid && bidValue <= remainingBudget
    const bidReady = controller.actionsReady && controller.realtimeConnected && !controller.bidding

    return <>
        <View style={[styles.card, compact && styles.cardCompact, urgent && styles.cardUrgent]}>
            <View style={[styles.liveLayout, compact && styles.liveLayoutCompact]}>
                <View style={styles.playerInfo}>
                    <Text style={styles.cardLabel}>On the block</Text>
                    <View style={styles.playerRow}>
                        <PlayerRowContent name={nomination.player?.displayName ?? 'Unknown Player'} nbaId={nomination.player?.nbaId}
                            team={nomination.player?.nbaTeam} yearsExp={nomination.player?.yearsExp} careerGames={nomination.player?.careerGames} injuryStatus={nomination.player?.injuryStatus} positions={nomination.player?.position ? [nomination.player.position] : []}
                            stats={draftAgeLabel(nomination.player?.age)} />
                    </View>
                </View>
                <View style={[styles.bidPanel, compact && styles.bidPanelCompact]}
                    testID="auction-live-state" accessibilityLabel={liveStateLabel}>
                    <View style={styles.bidRow}>
                        <View style={styles.bidInfo}>
                            <Text style={[styles.bidAmount, leading && styles.bidAmountLeading]}>
                                {nomination.currentBidAmount > 0 ? `$${nomination.currentBidAmount}` : '—'}
                            </Text>
                            <Text style={[styles.bidLeader, leading && styles.bidLeaderLeading]}>
                                {leaderText}
                            </Text>
                        </View>
                        <View style={[styles.countdown, urgent && styles.countdownUrgent]}>
                            <Text style={[styles.countdownText, paused && styles.countdownTextPaused, urgent && styles.countdownTextUrgent]}>
                                {paused ? 'Paused' : formatCountdown(controller.timeLeft)}
                            </Text>
                        </View>
                    </View>
                    {!state.draft.isMock && !leading ? <TaxiAcquisitionChoice value={controller.bidToTaxi}
                        onChange={controller.setBidToTaxi} disabled={controller.bidding || paused}
                        label="Receive this auction player into taxi" /> : null}
                    {leading && nomination.currentBidToTaxi ? <Text style={textStyles.meta}>Winning destination: Taxi squad</Text> : null}
                    {!leading && (budget?.remaining ?? 0) >= 1 && !paused ? <View style={styles.bidInputRow}>
                        <View style={styles.bidStepGroup}>
                            <MotionPressable style={styles.bidStep}
                                onPress={() => controller.setBidText((value) => String(Math.max(minimumBid, (parseInt(value, 10) || minimumBid) - 1)))}
                                disabled={!bidReady} accessibilityRole="button" accessibilityLabel="Decrease bid" hitSlop={8}>
                                <Text style={styles.bidStepText}>−</Text>
                            </MotionPressable>
                            <TextInput style={[styles.bidAmountInput, compact && styles.bidAmountInputCompact]}
                                value={controller.bidText} onChangeText={(value) => controller.setBidText(value.replace(/[^0-9]/g, ''))}
                                editable={bidReady} keyboardType="number-pad" selectTextOnFocus accessibilityLabel="Bid amount" />
                            <MotionPressable style={styles.bidStep}
                                onPress={() => controller.setBidText((value) => String(Math.min(
                                    remainingBudget, (parseInt(value, 10) || minimumBid - 1) + 1,
                                )))} disabled={!bidReady} accessibilityRole="button" accessibilityLabel="Increase bid" hitSlop={8}>
                                <Text style={styles.bidStepText}>+</Text>
                            </MotionPressable>
                        </View>
                        <MotionPressable style={[styles.bidButton, compact && styles.bidButtonCompact,
                            (controller.bidding || !bidValid) && styles.bidButtonDisabled]}
                            onPress={controller.handleBid} accessibilityRole="button"
                            accessibilityLabel={`Bid $${(bidValid ? bidValue : minimumBid).toLocaleString()}`}
                            accessibilityHint="Bidding requires a live draft connection."
                            disabled={!bidReady || !bidValid || leading || controller.timeLeft === 0}>
                            <Text style={styles.bidButtonText}>Bid ${(bidValid ? bidValue : minimumBid).toLocaleString()}</Text>
                        </MotionPressable>
                    </View> : null}
                </View>
            </View>
            {nomination.nominatingMemberId === memberId && !paused && nomination.currentBidderId == null ?
                <MotionPressable style={styles.withdrawButton} onPress={controller.handleWithdraw}
                    disabled={controller.withdrawing || !controller.actionsReady} accessibilityRole="button" accessibilityLabel="Withdraw nomination">
                    <Text style={styles.withdrawButtonText}>Withdraw nomination</Text>
                </MotionPressable> : null}
        </View>
        <View style={styles.historyPanel}>
            <View style={styles.historyHeader}>
                <Text style={styles.historyLabel}>Bid history</Text>
                <Text style={styles.historyCount}>{bidLabel}</Text>
            </View>
            {activeBids.length === 0
                ? <Text style={styles.historyEmpty}>No bids yet. Minimum bid is ${minimumBid}.</Text>
                : <View style={styles.historyItems}>{activeBids.slice(0, 6).map((bid, index) => {
                    const high = bid.memberId === nomination.currentBidderId && index === 0
                    return <View key={bid.id} style={styles.historyItem}>
                        <View style={[styles.orderPill, high && styles.orderPillHigh]}>
                            <Text style={[styles.orderText, high && styles.orderTextHigh]}>
                                {high ? 'High' : 'Outbid'}
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
    card: { backgroundColor: colors.bgCard, borderRadius: radii.lg, borderCurve: 'continuous', borderWidth: 1,
        borderColor: colors.borderLight, padding: spacing.xl, gap: spacing.md },
    cardCompact: { padding: spacing.md, gap: spacing.sm },
    cardUrgent: { borderColor: colors.danger, boxShadow: `0 0 0 3px ${tints.dangerFocusRing}` },
    cardLabel: { ...textStyles.sectionLabel },
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
        paddingHorizontal: spacing.md, paddingVertical: spacing.xxs, borderRadius: radii.full, overflow: 'hidden', alignSelf: 'flex-start' },
    countdown: { width: controlSize.button.lg.height + spacing['2xl'], height: controlSize.button.lg.height + spacing.md,
        flexShrink: 0, paddingHorizontal: spacing.sm, borderRadius: radii.full, borderCurve: 'continuous', backgroundColor: colors.bgMuted,
        borderWidth: 2, borderColor: colors.bgMuted,
        justifyContent: 'center', alignItems: 'center' },
    countdownUrgent: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
    countdownText: { fontSize: fontSize['2lg'], fontFamily: fontFamily.display, fontWeight: fontWeight.bold, color: colors.textSecondary,
        width: '100%', textAlign: 'center', fontVariant: textStyles.stat.fontVariant },
    countdownTextPaused: { fontSize: fontSize.sm },
    countdownTextUrgent: { color: colors.dangerDark },
    bidInputRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
    bidStepGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexShrink: 0 },
    bidStep: { width: 44, height: controlSize.minTouch, borderRadius: 22, borderCurve: 'continuous', backgroundColor: colors.bgMuted,
        justifyContent: 'center', alignItems: 'center' },
    bidStepText: { fontSize: fontSize.xl, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    bidAmountInput: { fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, width: 84, height: controlSize.minTouch,
        textAlign: 'center', backgroundColor: colors.bgMuted, borderRadius: radii.md, borderCurve: 'continuous', paddingHorizontal: spacing.md },
    bidAmountInputCompact: { width: 70, minWidth: 70 },
    bidButton: { flex: 1, minWidth: 112, height: controlSize.minTouch, backgroundColor: colors.primary, borderRadius: radii.md,
        borderCurve: 'continuous', justifyContent: 'center', alignItems: 'center' },
    bidButtonCompact: { minWidth: 96 },
    bidButtonDisabled: { opacity: 0.5 },
    bidButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    withdrawButton: { minHeight: controlSize.minTouch, marginTop: spacing.md, alignItems: 'center', justifyContent: 'center',
        paddingVertical: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
    withdrawButtonText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
    historyPanel: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
        borderRadius: radii.lg, borderCurve: 'continuous', backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.borderLight },
    historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    historyLabel: { ...textStyles.sectionLabel },
    historyCount: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    historyEmpty: { fontSize: fontSize.sm, color: colors.textSecondary },
    historyItems: { gap: spacing.xs },
    historyItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 38 },
    orderPill: { minWidth: 60, minHeight: 26, borderRadius: radii.full, borderCurve: 'continuous',
        backgroundColor: colors.bgScreen, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
    orderPillHigh: { backgroundColor: colors.successLight },
    orderText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    orderTextHigh: { color: colors.successDark },
    historyInfo: { flex: 1, minWidth: 0 },
    historyTeam: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
    historyMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.xxs },
    historyAmount: { fontSize: fontSize.sm, fontFamily: fontFamily.display, fontWeight: fontWeight.bold, color: colors.primaryDark },
    historyAmountHigh: { color: colors.successDark },
})
