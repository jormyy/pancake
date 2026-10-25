import { memo, useEffect, useState, type ReactNode } from 'react'
import { View, Text, StyleSheet, TextInput } from 'react-native'
import { colors, controlSize, fontSize, fontWeight, radii, spacing, table, textStyles, uiColors } from '@/constants/tokens'
import { isIREligible, RosterPlayer } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { TradePickItem } from '@/lib/trades'
import { claimProcessTimeLabel, WaiverClaim } from '@/lib/waivers'
import { playerYearsExperienceLabel } from '@/lib/player-context'
import { formatPoints, playerHeadshotUrl } from '@/lib/format'
import { rosterSlotLabel } from '@/lib/roster-slots'
import { Avatar } from '@/components/Avatar'
import { InjuryBadge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { MotionPressable, MotionView } from '@/components/Motion'

const ROW_AVATAR = 36
export const ROSTER_SLOT_TAG_WIDTH = 52

/**
 * Fixed-width lineup role for a roster row: a filled tag for a starting slot,
 * a dashed outline for BENCH, and the reserve tones for IR and TAXI.
 * Solid theme tokens only: alpha() tints of themed colors do not render on web.
 */
export function RosterSlotTag({ slotType }: { slotType: string }) {
    const tone = slotType === 'BE' ? styles.slotTagBench
        : slotType === 'IR' ? styles.slotTagIR
        : slotType === 'TX' ? styles.slotTagTaxi
        : styles.slotTagStarter
    const textTone = slotType === 'BE' ? styles.slotTagTextBench
        : slotType === 'IR' ? styles.slotTagTextIR
        : slotType === 'TX' ? styles.slotTagTextTaxi
        : styles.slotTagTextStarter
    return (
        <View style={[styles.slotTag, tone]}>
            <Text style={[styles.slotTagText, textTone]}>{rosterSlotLabel(slotType)}</Text>
        </View>
    )
}

/** Band at the top of a roster section card: label left, optional detail right. */
export function RosterSectionBand({ label, detail, tone = 'default' }: { label: string; detail?: ReactNode; tone?: 'default' | 'taxi' | 'starters' }) {
    return (
        <View style={[styles.band, tone === 'taxi' && styles.bandTaxi, tone === 'starters' && styles.bandStarters]} role="heading" aria-level={2} accessibilityRole="header" accessibilityLabel={label}>
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
    return (
        <View style={styles.metaRow}>
            {team ? <Text style={styles.meta}>{team}</Text> : null}
            {positions.map((pos) => <PosTag key={pos} position={pos} />)}
            {avgFpts != null || avgMinutes != null ? (
                <Text style={styles.averages}>
                    {avgFpts != null ? <Text style={styles.fantasyPoints}>{formatPoints(avgFpts)} FP</Text> : null}
                    {avgFpts != null && avgMinutes != null ? ' · ' : ''}
                    {avgMinutes != null ? `${formatPoints(avgMinutes)} MIN` : null}
                </Text>
            ) : null}
            {extra ? <Text style={styles.meta}>{extra}</Text> : null}
        </View>
    )
}

export const RosterClaimItem = memo(function RosterClaimItem({
    claim,
    cancellingId,
    waiverMode = 'rolling',
    onCancel,
    onEditBid,
    onReorder,
}: {
    claim: WaiverClaim
    cancellingId: string | null
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
        ? `Processes ${claimProcessTimeLabel(claim.clearsAt ?? null)}`
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
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${claim.playerName} claim up`}
                    >
                        <Text style={styles.miniButtonText}>↑</Text>
                    </MotionPressable>
                    <MotionPressable
                        style={styles.miniButton}
                        onPress={() => onReorder(claim.id, 'down')}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${claim.playerName} claim down`}
                    >
                        <Text style={styles.miniButtonText}>↓</Text>
                    </MotionPressable>
                    {usesFaab ? (
                        <MotionPressable
                            style={styles.miniButton}
                            onPress={() => onEditBid(claim, Math.max(0, parseInt(bidText || '0', 10) || 0))}
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
    slotType,
    togglingId,
    taxiingId,
    droppingId,
    avgFpts,
    avgMinutes,
    onPress,
    onLongPress,
    onToggleIR,
    allowIR = true,
}: {
    item: RosterPlayer
    slotType: string
    togglingId: string | null
    taxiingId: string | null
    droppingId: string | null
    avgFpts?: number
    avgMinutes?: number | null
    onPress: (item: RosterPlayer) => void
    onLongPress: (item: RosterPlayer) => void
    onToggleIR: (item: RosterPlayer) => void
    allowIR?: boolean
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
                accessibilityRole="button"
                accessibilityLabel={`Open ${player.display_name}`}
            >
                <RosterSlotTag slotType={slotType} />
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

            {(item.is_on_ir || allowIR && isIREligible(player.injury_status)) ? (
                <View style={styles.rowActions}>
                    <MotionPressable
                        style={[styles.actionButton, item.is_on_ir && styles.irButtonActive]}
                        onPress={() => onToggleIR(item)}
                        disabled={isBusy}
                        accessibilityRole="button"
                        accessibilityLabel={`${item.is_on_ir ? 'Activate' : 'Move'} ${player.display_name}${item.is_on_ir ? '' : ' to IR'}`}
                    >
                        <Text style={[styles.actionButtonText, item.is_on_ir && styles.actionButtonTextActive]}>
                            {item.is_on_ir ? 'Activate' : 'IR'}
                        </Text>
                    </MotionPressable>
                </View>
            ) : null}
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
    const yearsLabel = player.years_exp != null && player.years_exp <= 0 ? playerYearsExperienceLabel(player.years_exp) : null

    return (
        <MotionPressable
            style={styles.row}
            onPress={onPress}
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
                <PlayerMetaLine
                    team={player.nba_team}
                    positions={positions}
                    avgFpts={avgFpts}
                    avgMinutes={avgMinutes}
                    extra={yearsLabel}
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
                accessibilityRole="button"
                accessibilityLabel={`Open ${player.display_name}`}
            >
                <RosterSlotTag slotType="TX" />
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
        minHeight: table.headerHeight,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        backgroundColor: colors.bgSubtle,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    bandTaxi: { backgroundColor: colors.infoLight },
    bandStarters: { backgroundColor: colors.primaryLight },
    bandLabel: { ...textStyles.sectionLabel, flex: 1 },
    bandLabelTaxi: { color: colors.info },
    bandDetail: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },

    slotTag: {
        width: ROSTER_SLOT_TAG_WIDTH,
        minHeight: 22,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.xs,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
    },
    slotTagStarter: { backgroundColor: colors.primaryLight, borderColor: colors.primaryBorder },
    slotTagBench: { borderColor: colors.border, borderStyle: 'dashed' as const },
    slotTagIR: { backgroundColor: colors.dangerLight, borderColor: uiColors.dangerBorder },
    slotTagTaxi: { backgroundColor: colors.infoLight, borderColor: colors.info },
    slotTagText: { fontSize: fontSize['2xs'], fontWeight: fontWeight.extrabold, letterSpacing: 0.3 },
    slotTagTextStarter: { color: colors.primaryDark },
    slotTagTextBench: { color: colors.textSecondary },
    slotTagTextIR: { color: colors.dangerDark },
    slotTagTextTaxi: { color: colors.info },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: table.rowHeight,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        gap: spacing.md,
    },
    rowMain: { flex: 1, minWidth: 0, minHeight: controlSize.minTouch, flexDirection: 'row', alignItems: 'center', gap: spacing.md },

    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
    name: { ...textStyles.rowTitle, flexShrink: 1 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    meta: { ...textStyles.meta, color: colors.textSecondary },
    averages: { ...textStyles.stat },
    fantasyPoints: { fontWeight: fontWeight.bold, color: colors.primaryDark },

    rowActions: { flexDirection: 'row', gap: spacing.sm },

    actionButton: {
        minHeight: controlSize.minTouch,
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

    claimRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
    claimTop: { flexDirection: 'row', alignItems: 'center', minHeight: controlSize.minTouch, gap: spacing.md },
    claimEditRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    // 16px text keeps iOS Safari from zooming the page when the field focuses.
    claimBidInput: {
        width: 64,
        minHeight: controlSize.minTouch,
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
        minHeight: controlSize.minTouch,
        minWidth: controlSize.minTouch,
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
