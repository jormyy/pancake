import { memo, useEffect, useState, type ReactNode } from 'react'
import { View, Text, StyleSheet, TextInput } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, textStyles, uiColors } from '@/constants/tokens'
import { isIREligible, isTaxiEligible, RosterPlayer } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { TradePickItem } from '@/lib/trades'
import { WaiverClaim } from '@/lib/waivers'
import { playerYearsExperienceLabel } from '@/lib/player-context'
import { formatPoints, safeShortDate, playerHeadshotUrl } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { Badge, InjuryBadge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { MotionPressable, MotionView } from '@/components/Motion'

const ROW_AVATAR = 36

/** Band at the top of a roster section card: label left, optional detail right. */
export function RosterSectionBand({ label, detail, tone = 'default' }: { label: string; detail?: ReactNode; tone?: 'default' | 'taxi' }) {
    return (
        <View style={[styles.band, tone === 'taxi' && styles.bandTaxi]} role="heading" aria-level={2} accessibilityRole="header" accessibilityLabel={label}>
            <Text style={[styles.bandLabel, tone === 'taxi' && styles.bandLabelTaxi]}>{label}</Text>
            {detail ? <View style={styles.bandDetail}>{detail}</View> : null}
        </View>
    )
}

// Second row line: team, positions, then the season averages that drive
// lineup decisions. Wraps under the name instead of growing the row.
function PlayerMetaLine({
    team,
    positions,
    avgFpts,
    avgMinutes,
    extra,
}: {
    team: string | null | undefined
    positions: string[]
    avgFpts?: number
    avgMinutes?: number | null
    extra?: string | null
}) {
    const averages = [
        avgFpts != null ? `${formatPoints(avgFpts)} FP` : null,
        avgMinutes != null ? `${formatPoints(avgMinutes)} MIN` : null,
    ].filter(Boolean).join(' · ')
    return (
        <View style={styles.metaRow}>
            {team ? <Text style={styles.meta}>{team}</Text> : null}
            {positions.map((pos) => <PosTag key={pos} position={pos} />)}
            {averages ? <Text style={styles.averages}>{averages}</Text> : null}
            {extra ? <Text style={styles.meta}>{extra}</Text> : null}
        </View>
    )
}

export const RosterClaimItem = memo(function RosterClaimItem({
    claim,
    cancellingId,
    waiverPriority,
    waiverMode = 'rolling',
    onCancel,
    onEditBid,
    onReorder,
}: {
    claim: WaiverClaim
    cancellingId: string | null
    waiverPriority: number | null
    waiverMode?: 'rolling' | 'faab'
    onCancel: (id: string) => void
    onEditBid: (claim: WaiverClaim, bidAmount: number) => void
    onReorder: (id: string, direction: 'up' | 'down') => void
}) {
    const isPending = claim.status === 'pending'
    const usesFaab = waiverMode === 'faab'
    const [bidText, setBidText] = useState(String(claim.bidAmount ?? 0))
    useEffect(() => {
        setBidText(String(claim.bidAmount ?? 0))
    }, [claim.bidAmount])
    const statusColor =
        claim.status === 'succeeded' ? colors.successDark
        : claim.status === 'pending' ? colors.info
        : colors.dangerDark
    const statusText = claim.status === 'pending'
        ? `Processes ${safeShortDate(claim.processDate ? `${claim.processDate}T12:00:00Z` : null) || 'soon'}`
        : claim.status === 'succeeded'
          ? 'Succeeded'
          : claim.status === 'failed_roster'
            ? 'Failed: roster full'
            : 'Failed: outbid'
    return (
        // Name and Cancel share the top line; the edit controls get a full-width
        // line below, so nothing wraps on a narrow phone.
        <MotionView style={styles.claimRow} preset="rise">
            <View style={styles.claimTop}>
                {isPending && waiverPriority != null ? (
                    <View style={styles.priorityBadge} accessibilityLabel={`Waiver priority ${waiverPriority}`}>
                        <Text style={styles.priorityBadgeText}>#{waiverPriority}</Text>
                    </View>
                ) : null}
                <Avatar
                    name={claim.playerName}
                    color={colors.bgMuted}
                    textColor={colors.textSecondary}
                    uri={playerHeadshotUrl(claim.playerNbaId) ?? undefined}
                    size={ROW_AVATAR}
                />
                <View style={styles.info}>
                    <Text style={styles.name} numberOfLines={1}>{claim.playerName}</Text>
                    <Text style={styles.meta} numberOfLines={2}>
                        {[
                            claim.dropPlayerName ? `Drop ${claim.dropPlayerName}` : null,
                            `Order ${claim.claimOrder}`,
                            usesFaab ? `Bid $${claim.bidAmount}` : null,
                        ].filter(Boolean).join(' · ')}
                    </Text>
                    <Text style={[styles.meta, { color: statusColor }]}>{statusText}</Text>
                    {claim.failureReason ? (
                        <Text style={[styles.meta, { color: colors.dangerDark }]}>{claim.failureReason}</Text>
                    ) : null}
                </View>
                {isPending ? (
                    <MotionPressable
                        style={styles.actionButton}
                        onPress={() => onCancel(claim.id)}
                        disabled={cancellingId === claim.id}
                        pressedScale={0.92}
                        accessibilityRole="button"
                        accessibilityLabel={`Cancel claim for ${claim.playerName}`}
                    >
                        <Text style={styles.actionButtonText}>Cancel</Text>
                    </MotionPressable>
                ) : null}
            </View>
            {isPending ? (
                <View style={styles.claimEditRow}>
                    {usesFaab ? (
                        <TextInput
                            style={styles.claimBidInput}
                            value={bidText}
                            onChangeText={(value) => {
                                if (/^\d*$/.test(value)) setBidText(value)
                            }}
                            keyboardType="numeric"
                            accessibilityLabel={`Bid for ${claim.playerName}`}
                        />
                    ) : null}
                    <MotionPressable
                        style={styles.miniButton}
                        onPress={() => onReorder(claim.id, 'up')}
                        pressedScale={0.92}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${claim.playerName} claim up`}
                    >
                        <Text style={styles.miniButtonText}>↑</Text>
                    </MotionPressable>
                    <MotionPressable
                        style={styles.miniButton}
                        onPress={() => onReorder(claim.id, 'down')}
                        pressedScale={0.92}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${claim.playerName} claim down`}
                    >
                        <Text style={styles.miniButtonText}>↓</Text>
                    </MotionPressable>
                    {usesFaab ? (
                        <MotionPressable
                            style={styles.miniButton}
                            onPress={() => onEditBid(claim, Math.max(0, parseInt(bidText || '0', 10) || 0))}
                            pressedScale={0.92}
                            accessibilityRole="button"
                            accessibilityLabel={`Save bid for ${claim.playerName}`}
                        >
                            <Text style={styles.miniButtonText}>Save</Text>
                        </MotionPressable>
                    ) : null}
                </View>
            ) : null}
        </MotionView>
    )
})

export const RosterPickItem = memo(function RosterPickItem({
    pick,
    myTeamName,
}: {
    pick: TradePickItem
    myTeamName: string
}) {
    const isOwn = pick.originalTeamName === myTeamName
    return (
        <MotionView style={styles.row} preset="rise">
            <View style={styles.pickCircle}>
                <Text style={styles.pickCircleText}>
                    &apos;{String(pick.seasonYear).slice(2)}
                </Text>
            </View>
            <View style={styles.info}>
                <Text style={styles.name}>
                    {pick.seasonYear} Round {pick.round}
                </Text>
                {!isOwn ? (
                    <Text style={styles.meta}>via {pick.originalTeamName}</Text>
                ) : null}
            </View>
        </MotionView>
    )
})

export const RosterPlayerItem = memo(function RosterPlayerItem({
    item,
    togglingId,
    taxiingId,
    droppingId,
    taxiSlotsAvailable,
    avgFpts,
    avgMinutes,
    onPress,
    onLongPress,
    onToggleIR,
    onToggleTaxi,
}: {
    item: RosterPlayer
    togglingId: string | null
    taxiingId: string | null
    droppingId: string | null
    taxiSlotsAvailable: boolean
    avgFpts?: number
    avgMinutes?: number | null
    onPress: (item: RosterPlayer) => void
    onLongPress: (item: RosterPlayer) => void
    onToggleIR: (item: RosterPlayer) => void
    onToggleTaxi: (item: RosterPlayer) => void
}) {
    const player = item.players
    const positions = getEligiblePositions(player)
    const isBusy = togglingId === item.id || taxiingId === item.id || droppingId === item.id
    const headshotUri = playerHeadshotUrl(player.nba_id)
    return (
        <View style={styles.row}>
            <MotionPressable
                style={styles.rowMain}
                onPress={() => onPress(item)}
                onLongPress={() => onLongPress(item)}
                delayLongPress={400}
                pressedScale={0.985}
                accessibilityRole="button"
                accessibilityLabel={`Open ${player.display_name}`}
            >
                <Avatar
                    name={player.display_name}
                    color={colors.bgMuted}
                    textColor={colors.textSecondary}
                    uri={headshotUri ?? undefined}
                    size={ROW_AVATAR}
                />

                <View style={styles.info}>
                    <View style={styles.nameRow}>
                        <Text style={styles.name} numberOfLines={1}>{player.display_name}</Text>
                        <InjuryBadge status={player.injury_status} />
                    </View>
                    <PlayerMetaLine team={player.nba_team} positions={positions} avgFpts={avgFpts} avgMinutes={avgMinutes} />
                </View>
            </MotionPressable>

            <View style={styles.rowActions}>
                {(item.is_on_ir || isIREligible(player.injury_status)) ? (
                    <MotionPressable
                        style={[styles.actionButton, item.is_on_ir && styles.irButtonActive]}
                        onPress={() => onToggleIR(item)}
                        disabled={isBusy}
                        pressedScale={0.92}
                        accessibilityRole="button"
                        accessibilityLabel={`${item.is_on_ir ? 'Activate' : 'Move'} ${player.display_name}${item.is_on_ir ? '' : ' to IR'}`}
                    >
                        <Text style={[styles.actionButtonText, item.is_on_ir && styles.actionButtonTextActive]}>
                            {item.is_on_ir ? 'Activate' : 'IR'}
                        </Text>
                    </MotionPressable>
                ) : null}
                {!item.is_on_ir && taxiSlotsAvailable && isTaxiEligible(player) ? (
                    <MotionPressable
                        style={[styles.actionButton, styles.taxiButtonOutline]}
                        onPress={() => onToggleTaxi(item)}
                        disabled={isBusy}
                        pressedScale={0.92}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${player.display_name} to taxi`}
                    >
                        <Text style={styles.taxiButtonOutlineText}>Taxi</Text>
                    </MotionPressable>
                ) : null}
            </View>
        </View>
    )
})

export const ReadOnlyRosterPlayerItem = memo(function ReadOnlyRosterPlayerItem({
    item,
    avgFpts,
    avgMinutes,
    onPress,
}: {
    item: RosterPlayer
    avgFpts?: number
    avgMinutes?: number | null
    onPress: () => void
}) {
    const player = item.players
    const positions = getEligiblePositions(player)
    const headshotUri = playerHeadshotUrl(player.nba_id)
    const yearsLabel = playerYearsExperienceLabel(player.years_exp)
    const hasStats = avgFpts != null || avgMinutes != null

    return (
        <MotionPressable
            style={styles.row}
            onPress={onPress}
            pressedScale={0.985}
            accessibilityRole="button"
            accessibilityLabel={`Open ${player.display_name}`}
        >
            <Avatar
                name={player.display_name}
                color={colors.bgMuted}
                textColor={colors.textSecondary}
                uri={headshotUri ?? undefined}
                size={ROW_AVATAR}
            />

            <View style={styles.info}>
                <View style={styles.nameRow}>
                    <Text style={styles.name} numberOfLines={1}>{player.display_name}</Text>
                    <InjuryBadge status={player.injury_status} />
                    {item.is_on_ir ? <Badge label="IR" color={colors.textMuted} variant="soft" /> : null}
                    {item.is_on_taxi ? <Badge label="TX" color={colors.textMuted} variant="soft" /> : null}
                </View>
                <PlayerMetaLine
                    team={player.nba_team}
                    positions={positions}
                    avgFpts={avgFpts}
                    avgMinutes={avgMinutes}
                    extra={hasStats ? yearsLabel : [yearsLabel, 'No season stats'].filter(Boolean).join(' · ')}
                />
            </View>
            <Text style={styles.chevron} aria-hidden>›</Text>
        </MotionPressable>
    )
})

export const TaxiPlayerItem = memo(function TaxiPlayerItem({
    item,
    taxiingId,
    avgFpts,
    avgMinutes,
    onPress,
    onToggleTaxi,
}: {
    item: RosterPlayer
    taxiingId: string | null
    avgFpts?: number
    avgMinutes?: number | null
    onPress: (item: RosterPlayer) => void
    onToggleTaxi: (item: RosterPlayer) => void
}) {
    const player = item.players
    const positions = getEligiblePositions(player)
    const headshotUri = playerHeadshotUrl(player.nba_id)
    return (
        <View style={styles.row}>
            <MotionPressable
                style={styles.rowMain}
                onPress={() => onPress(item)}
                pressedScale={0.985}
                accessibilityRole="button"
                accessibilityLabel={`Open ${player.display_name}`}
            >
                <Avatar
                    name={player.display_name}
                    color={colors.bgMuted}
                    textColor={colors.textSecondary}
                    uri={headshotUri ?? undefined}
                    size={ROW_AVATAR}
                />

                <View style={styles.info}>
                    <Text style={styles.name} numberOfLines={1}>{player.display_name}</Text>
                    <PlayerMetaLine team={player.nba_team} positions={positions} avgFpts={avgFpts} avgMinutes={avgMinutes} />
                </View>
            </MotionPressable>

            <MotionPressable
                style={[styles.actionButton, styles.taxiButtonActive]}
                onPress={() => onToggleTaxi(item)}
                disabled={taxiingId === item.id}
                pressedScale={0.92}
                accessibilityRole="button"
                accessibilityLabel={`Activate ${player.display_name}`}
                accessibilityState={{ disabled: taxiingId === item.id }}
            >
                <Text style={[styles.actionButtonText, styles.actionButtonTextActive]}>Activate</Text>
            </MotionPressable>
        </View>
    )
})

const styles = StyleSheet.create({
    band: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 36,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        backgroundColor: colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    bandTaxi: { backgroundColor: colors.infoLight },
    bandLabel: { ...textStyles.sectionLabel, flex: 1 },
    bandLabelTaxi: { color: colors.info },
    bandDetail: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 52,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        gap: spacing.md,
    },
    rowMain: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.md },

    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
    name: { ...textStyles.rowTitle, flexShrink: 1 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    meta: { ...textStyles.meta },
    averages: { ...textStyles.meta, fontWeight: fontWeight.bold, color: colors.primaryDark, fontVariant: ['tabular-nums'] as const },

    rowActions: { flexDirection: 'row', gap: spacing.sm },

    actionButton: {
        minHeight: 44,
        minWidth: 52,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    irButtonActive: { backgroundColor: colors.danger, borderColor: colors.danger },
    taxiButtonActive: { backgroundColor: colors.info, borderColor: colors.info },
    taxiButtonOutline: { borderColor: colors.info },
    taxiButtonOutlineText: { fontSize: fontSize['2sm'], fontWeight: fontWeight.bold, color: colors.info },
    actionButtonText: { fontSize: fontSize['2sm'], fontWeight: fontWeight.bold, color: colors.textSecondary },
    actionButtonTextActive: { color: colors.onAccent },

    pickCircle: {
        width: ROW_AVATAR,
        height: ROW_AVATAR,
        borderRadius: ROW_AVATAR / 2,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.info,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleText: { color: colors.onAccent, fontWeight: fontWeight.bold, fontSize: fontSize['2sm'] },

    priorityBadge: {
        width: 32,
        height: 32,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: uiColors.taxi,
        justifyContent: 'center',
        alignItems: 'center',
    },
    priorityBadgeText: { color: colors.onAccent, fontWeight: fontWeight.bold, fontSize: fontSize.xs },
    claimRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
    claimTop: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.md },
    claimEditRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    // 16px text keeps iOS Safari from zooming the page when the field focuses.
    claimBidInput: {
        width: 64,
        minHeight: 44,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.sm,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        backgroundColor: colors.bgInput,
    },
    miniButton: {
        minHeight: 44,
        minWidth: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.sm,
    },
    miniButtonText: { fontSize: fontSize['2sm'], fontWeight: fontWeight.bold, color: colors.textSecondary },
    chevron: { fontSize: fontSize.xl, color: colors.textPlaceholder },
})
