import { LockedAssetNotice } from '@/components/roster/LockedAssetNotice'
import { readAssetLocks } from '@/lib/locked-assets'
import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { PendingMutationBadge } from '@/components/PendingMutationBadge'
import { SectionBand } from '@/components/ui/SectionBand'
import { pickLabel, draftYear } from '@/lib/picks'
import { useUnsentFormUpdate } from '@/hooks/use-unsent-form-update'
import { isTaxiEligible } from '@pancake/core'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { memo, useContext, useEffect, useState, type ReactNode } from 'react'
import { View, Text, StyleSheet, TextInput, Switch } from 'react-native'
import { colors, componentTokens, controlSize, fontSize, fontWeight, radii, spacing, table, textStyles, uiColors, tracking } from '@/constants/tokens'
import { isIREligible, RosterPlayer } from '@/lib/roster'
import { getEligiblePositions } from '@/lib/players'
import { TradePickItem } from '@/lib/trades'
import { scheduledClaimLabel, scheduledClaimRunAt, WaiverClaim } from '@/lib/waivers'
import { formatPoints } from '@/lib/format'
import { rosterSlotLabel } from '@/lib/roster-slots'


import { MotionPressable, MotionView } from '@/components/Motion'

const ROW_AVATAR = controlSize.avatar.md
const ROSTER_TAG_HEIGHT = 22
export const ROSTER_SLOT_TAG_WIDTH = controlSize.minTouch
export const rosterActionDisabledStyle = { opacity: 0.5 }

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
    return <SectionBand label={label} detail={detail} tone={tone} />
}

function PlayerStats({ avgFpts, avgMinutes }: { avgFpts?: number; avgMinutes?: number | null }) {
    return <Text style={styles.averages}>
        <Text style={styles.fantasyPoints}>{formatPoints(avgFpts ?? 0)} FP</Text>
        {' · '}
        {`${formatPoints(avgMinutes ?? 0)} mins`}
    </Text>
}

export function RosterPlayerRow({ item, avgFpts, avgMinutes, leading, metadata, actions, stackedActions = false, onPress, onLongPress }: {
    item: RosterPlayer
    avgFpts?: number
    avgMinutes?: number | null
    leading?: ReactNode
    metadata?: ReactNode
    actions?: ReactNode
    stackedActions?: boolean
    onPress?: () => void
    onLongPress?: () => void
}) {
    const player = item.players
    const content = <>
        {leading}
        <PlayerRowContent name={player.display_name} nbaId={player.nba_id} team={player.nba_team} positions={getEligiblePositions(player)}
            birthdate={player.birthdate} yearsExp={player.years_exp} careerGames={player.career_regular_season_games}
            injuryStatus={player.injury_status} onTaxi={item.is_on_taxi} metadata={metadata}
            stats={<PlayerStats avgFpts={avgFpts} avgMinutes={avgMinutes} />} />
    </>
    return <View style={[styles.row, stackedActions && styles.stackedRow]}>
        {onPress ? <MotionPressable style={styles.rowMain} onPress={onPress} onLongPress={onLongPress}
            delayLongPress={400} accessibilityRole="button" accessibilityLabel={`Open ${player.display_name}`}>{content}</MotionPressable>
            : <View style={[styles.rowMain, stackedActions && styles.fullWidth]}>{content}</View>}
        {actions}
    </View>
}

export const RosterClaimItem = memo(function RosterClaimItem({
    claim,
    cancellingId,
    waiverMode = 'rolling',
    onCancel,
    onEditBid,
    onEditTaxi,
    onReorder,
    onTimeline,
}: {
    claim: WaiverClaim
    onTimeline?: () => void
    cancellingId: string | null
    waiverMode?: 'rolling' | 'faab'
    onCancel: (id: string) => void
    onEditTaxi?: (claim: WaiverClaim, toTaxi: boolean) => void
    onEditBid: (claim: WaiverClaim, bidAmount: number) => Promise<boolean | undefined>
    onReorder: (id: string, direction: 'up' | 'down') => void
}) {
    const timezone = useLeagueTimezone()
    const taxiSlots = useContext(PlayerEligibilityContext)
    const taxiEligible = taxiSlots > 0 && isTaxiEligible(claim.playerYearsExp ?? null, claim.playerCareerGames ?? null)
    const isPending = claim.status === 'pending'
    const editable = isPending && scheduledClaimRunAt(claim.processDate, timezone).getTime() > Date.now()
    const disabled = cancellingId !== null
    const usesFaab = waiverMode === 'faab'
    const [bidText, setBidText] = useState(String(claim.bidAmount ?? 0))
    useUnsentFormUpdate(editable && usesFaab && bidText !== String(claim.bidAmount ?? 0), 'pending claim bid')
    useEffect(() => {
        setBidText(String(claim.bidAmount ?? 0))
    }, [claim.bidAmount])
    const statusColor =
        claim.status === 'succeeded' ? colors.successDark
        : claim.status === 'pending' ? colors.info
        : colors.dangerDark
    const statusText = claim.status === 'pending'
        ? `Processes ${scheduledClaimLabel(claim.processDate, timezone)}`
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
                <PendingMutationBadge rowId={claim.id} />
                <PlayerRowContent name={claim.playerName} nbaId={claim.playerNbaId} team={claim.playerTeam} positions={claim.playerPosition ? [claim.playerPosition] : []} injuryStatus={claim.playerInjuryStatus}
                    playerId={claim.playerId} yearsExp={claim.playerYearsExp} careerGames={claim.playerCareerGames}
                    stats={<View>
                        <Text style={styles.meta} numberOfLines={2}>{[
                            claim.toTaxi ? 'To taxi' : claim.toIr ? 'To IR' : null,
                            claim.dropPlayerName ? `Drop ${claim.dropPlayerName}` : null,
                            usesFaab ? `Bid $${claim.bidAmount}` : null,
                        ].filter(Boolean).join(' · ')}</Text>
                        <Text style={[styles.meta, { color: statusColor }]}>{statusText}</Text>
                        {claim.failureReason ? <Text style={[styles.meta, { color: colors.dangerDark }]}>{claim.failureReason}</Text> : null}
                    </View>} />
                {editable ? (
                    <MotionPressable
                        style={styles.actionButton}
                        onPress={() => onCancel(claim.id)}
                        disabled={disabled}
                        accessibilityRole="button"
                        accessibilityLabel={`Cancel claim for ${claim.playerName}`}
                    >
                        <Text style={styles.actionButtonText}>Cancel</Text>
                    </MotionPressable>
                ) : null}
            </View>
            {onTimeline ? <MotionPressable onPress={onTimeline} accessibilityRole="button" accessibilityLabel="What happened?" style={styles.actionButton}>
                <Text style={styles.actionButtonText}>What happened?</Text>
            </MotionPressable> : null}
            {editable && taxiEligible && onEditTaxi ? <View style={styles.claimEditRow}>
                <Text style={styles.meta}>Place on taxi</Text>
                <Switch value={claim.toTaxi ?? false} onValueChange={value => { if (value !== Boolean(claim.toTaxi)) onEditTaxi(claim, value) }} accessibilityLabel={`Place ${claim.playerName} on taxi`} disabled={disabled} />
            </View> : null}
            {editable ? (
                <View style={styles.claimEditRow}>
                    {usesFaab ? (
                        <TextInput
                            style={styles.claimBidInput}
                            value={bidText}
                            editable={!disabled}
                            onChangeText={(value) => {
                                if (/^\d*$/.test(value)) setBidText(value)
                            }}
                            keyboardType="numeric"
                            accessibilityLabel={`Bid for ${claim.playerName}`}
                        />
                    ) : null}
                    <MotionPressable
                        style={styles.miniButton}
                        disabled={disabled}
                        onPress={() => onReorder(claim.id, 'up')}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${claim.playerName} claim up`}
                    >
                        <Text style={styles.miniButtonText}>↑</Text>
                    </MotionPressable>
                    <MotionPressable
                        style={styles.miniButton}
                        disabled={disabled}
                        onPress={() => onReorder(claim.id, 'down')}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${claim.playerName} claim down`}
                    >
                        <Text style={styles.miniButtonText}>↓</Text>
                    </MotionPressable>
                    {usesFaab ? (
                        <MotionPressable
                            style={styles.miniButton}
                        disabled={disabled}
                            onPress={async () => {
                                const submitted = bidText
                                const amount = Math.max(0, parseInt(submitted || '0', 10) || 0)
                                if (await onEditBid(claim, amount)) setBidText(value => value === submitted ? String(amount) : value)
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`Save bid for ${claim.playerName}`}
                        >
                            <Text style={styles.miniButtonText}>Save</Text>
                        </MotionPressable>
                    ) : null}
                </View>
            ) : null}
            <LockedAssetNotice locks={readAssetLocks(claim)} />
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
    const locks = readAssetLocks(pick)
    return (
        <View><MotionView style={styles.row} preset="rise">
            <View style={styles.pickCircle}>
                <Text style={styles.pickCircleText}>
                    &apos;{String(draftYear(pick.seasonYear)).slice(2)}
                </Text>
            </View>
            <View style={styles.info}>
                <Text style={styles.name}>
                    {pickLabel(pick.seasonYear, pick.round)}
                </Text>
                {!isOwn ? (
                    <Text style={styles.meta}>via {pick.originalTeamName}</Text>
                ) : null}
            </View>
        </MotionView><LockedAssetNotice locks={locks} /></View>
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
    const isBusy = togglingId === item.id || taxiingId === item.id || droppingId === item.id

    const locks = readAssetLocks(item)
    return (
        <View><RosterPlayerRow item={item} avgFpts={avgFpts} avgMinutes={avgMinutes}
            leading={<><RosterSlotTag slotType={slotType} /><PendingMutationBadge rowId={player.id} /></>}
            onPress={() => onPress(item)} onLongPress={locks.length ? undefined : () => onLongPress(item)} actions={<>
            {(item.is_on_ir || allowIR && isIREligible(player.injury_status)) ? (
                <View style={styles.rowActions}>
                    <MotionPressable
                        style={styles.rosterActionTarget}
                        onPress={() => onToggleIR(item)}
                        disabled={isBusy || locks.length > 0}
                        accessibilityRole="button"
                        accessibilityLabel={`${item.is_on_ir ? 'Activate' : 'Move'} ${player.display_name}${item.is_on_ir ? '' : ' to IR'}`}
                    >
                        <View style={[styles.rosterAction, item.is_on_ir && styles.irButtonActive]}>
                            <Text style={[styles.actionButtonText, item.is_on_ir && styles.actionButtonTextActive]}>
                                {item.is_on_ir ? 'Activate' : 'IR'}
                            </Text>
                        </View>
                    </MotionPressable>
                </View>
            ) : null}
        </>} /><LockedAssetNotice locks={locks} /></View>
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


    return (
        <MotionPressable
            style={styles.row}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Open ${player.display_name}`}
        >
            <PendingMutationBadge rowId={player.id} />
                <PlayerRowContent name={player.display_name} nbaId={player.nba_id} team={player.nba_team} positions={positions}
                    birthdate={player.birthdate} yearsExp={player.years_exp} careerGames={player.career_regular_season_games} injuryStatus={player.injury_status} onTaxi={item.is_on_taxi}
                    stats={<PlayerStats avgFpts={avgFpts} avgMinutes={avgMinutes} />} />
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

    const locks = readAssetLocks(item)
    return (
        <View><View style={styles.row}>
            <MotionPressable
                style={styles.rowMain}
                onPress={() => onPress(item)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${player.display_name}`}
            >
                <RosterSlotTag slotType="TX" />
                <PendingMutationBadge rowId={player.id} />
                <PlayerRowContent name={player.display_name} nbaId={player.nba_id} team={player.nba_team} positions={positions}
                    birthdate={player.birthdate} yearsExp={player.years_exp} careerGames={player.career_regular_season_games} injuryStatus={player.injury_status} onTaxi={item.is_on_taxi}
                    stats={<PlayerStats avgFpts={avgFpts} avgMinutes={avgMinutes} />} />
            </MotionPressable>

            <MotionPressable
                style={styles.rosterActionTarget}
                onPress={() => onToggleTaxi(item)}
                disabled={taxiingId === item.id || locks.length > 0}
                accessibilityRole="button"
                accessibilityLabel={`Activate ${player.display_name}`}
                accessibilityState={{ disabled: taxiingId === item.id || locks.length > 0 }}
            >
                <View style={[styles.rosterAction, styles.taxiButtonActive]}>
                    <Text style={[styles.actionButtonText, styles.actionButtonTextActive]}>Activate</Text>
                </View>
            </MotionPressable>
        </View><LockedAssetNotice locks={locks} /></View>
    )
})

const styles = StyleSheet.create({
    slotTag: {
        width: ROSTER_SLOT_TAG_WIDTH,
        minHeight: ROSTER_TAG_HEIGHT,
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
    slotTagText: { fontSize: fontSize['2xs'], fontWeight: fontWeight.extrabold, letterSpacing: tracking.tight },
    slotTagTextStarter: { color: colors.primaryDark },
    slotTagTextBench: { color: colors.textSecondary },
    slotTagTextIR: { color: colors.dangerDark },
    slotTagTextTaxi: { color: colors.info },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: table.rowHeight,
        paddingHorizontal: spacing.sm,
        paddingVertical: componentTokens.playerRow.compact.paddingVertical,
        gap: spacing.xs,
    },
    stackedRow: { flexDirection: 'column', alignItems: 'stretch' },
    fullWidth: { flex: 0, width: '100%' },
    rowMain: { flex: 1, minWidth: 0, minHeight: controlSize.minTouch, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },

    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    name: { ...textStyles.rowTitle, flexShrink: 1 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    meta: { ...textStyles.meta, color: colors.textSecondary },
    averages: { ...textStyles.stat },
    fantasyPoints: { fontWeight: fontWeight.bold, color: colors.primaryDark },

    rowActions: { flexDirection: 'row', gap: spacing.sm },

    rosterActionTarget: { minHeight: controlSize.minTouch, minWidth: controlSize.minTouch, justifyContent: 'center', flexShrink: 0 },
    rosterAction: {
        height: ROSTER_TAG_HEIGHT,
        minWidth: controlSize.minTouch,
        paddingHorizontal: spacing.sm,
        borderRadius: radii.xs,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionButton: {
        minHeight: controlSize.minTouch,
        minWidth: controlSize.minTouch,
        paddingHorizontal: spacing.sm,
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
