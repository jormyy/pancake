import { View, Text, StyleSheet, Pressable } from 'react-native'
import type { ReactNode } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { blockedActionProps } from '@/lib/a11y'
import { INJURY_COLORS, colors, controlSize, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { PlayerAvatar } from './PlayerAvatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { getEligiblePositions } from '@/lib/players'

type PlayerHeaderPlayer = {
    display_name: string
    nba_team: string | null
    position: string | null
    eligible_positions: string[] | null
    jersey_number: string | null
    injury_status: string | null
    dynasty_rank: number | null
    headshot_url: string | null
    nba_id: string | null
    years_exp: number | null
}

export type PlayerHeaderAction = {
    label: string
    onPress: () => void
    disabled: boolean
    busy: boolean
    accessibilityLabel?: string
    blockedReason?: string | null
}

type Props = {
    player: PlayerHeaderPlayer
    rosterStatus: PlayerRosterStatus | null
    action?: PlayerHeaderAction | null
    backControl?: ReactNode
    claimPending?: boolean
    leagueActive: boolean
    actionsReady?: boolean
    actionLoading?: boolean
    dropDisabled?: boolean
    playedToday?: boolean
    addBlockedReason?: string | null
    addBlockedCaption?: string | null
    onAdd?: () => void
    onDrop?: () => void
    onClaim?: () => void
    onSetLineup?: () => void
    compact?: boolean
}

export function PlayerHeader({ player, rosterStatus, action, backControl, claimPending = false,
    leagueActive, actionsReady = true, actionLoading = false, dropDisabled = false,
    addBlockedReason = null, addBlockedCaption = null, onAdd, onDrop, onClaim, onSetLineup, compact = false }: Props) {
    const headshotSize = compact ? spacing['5xl'] : spacing['4xl'] * 2
    const eligiblePositions = getEligiblePositions(player)
    const fallback = rosterStatus?.status === 'free_agent' && onAdd ? { label: 'Add', onPress: onAdd, blockedReason: addBlockedReason }
        : rosterStatus?.status === 'on_waivers' && onClaim ? { label: claimPending ? 'Claim pending' : 'Claim', onPress: onClaim,
            accessibilityLabel: claimPending ? `Claim pending for ${player.display_name}, view claims` : `Claim ${player.display_name}` }
        : rosterStatus?.status === 'mine' && onSetLineup ? { label: 'Lineup', onPress: onSetLineup, accessibilityLabel: `Move ${player.display_name} in lineup` }
        : null
    const primary = action === undefined && fallback ? { disabled: !actionsReady, busy: actionLoading, ...fallback } : action
    const statusLabel = rosterStatus?.status === 'free_agent' ? 'Free agent'
        : rosterStatus?.status === 'on_waivers' ? 'On waivers'
        : rosterStatus?.status === 'mine' ? 'On your roster'
        : rosterStatus?.status === 'taken' ? rosterStatus.ownerTeamName : ' '
    const showDrop = rosterStatus?.status === 'mine' && onDrop != null
    const busy = primary?.busy || (!rosterStatus && leagueActive) || !actionsReady
    return (
        <View style={styles.header}>
            <View style={styles.identity}>
                {backControl}
                <View style={styles.avatarWrap}>
                    <PlayerAvatar name={player.display_name} nbaId={player.nba_id} size={headshotSize} />
                </View>
                <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={2} accessibilityLabel={player.display_name}>{player.display_name}</Text>
                <View style={styles.actionWrap} aria-busy={busy} accessibilityState={{ busy }} testID="player-action-slot">
                    {primary ? (
                        <Pressable style={[styles.action, showDrop && styles.rosterPrimary, primary.blockedReason && styles.pickupBlocked]}
                            onPress={primary.onPress} disabled={primary.disabled || primary.busy}
                            accessibilityRole="button" accessibilityLabel={primary.accessibilityLabel ?? `${primary.label} ${player.display_name}`}
                            {...blockedActionProps(primary.blockedReason ?? null, primary.disabled || primary.busy)}>
                            <Text style={[styles.actionText, primary.blockedReason && styles.pickupBlockedText]} numberOfLines={1}>{primary.label}</Text>
                        </Pressable>
                    ) : <View style={[styles.action, showDrop && styles.rosterPrimary, styles.placeholder]} accessibilityLabel={busy ? 'Loading player action' : 'No player action'} />}
                    {showDrop ? (
                        <Pressable style={styles.dropButton} onPress={onDrop} disabled={actionLoading || dropDisabled || !actionsReady}
                            accessibilityRole="button" accessibilityLabel={`Drop ${player.display_name}`}
                            accessibilityState={{ disabled: actionLoading || dropDisabled || !actionsReady }}>
                            <Text style={styles.dropText}>Drop</Text>
                        </Pressable>
                    ) : null}
                </View>
            </View>
            <View style={styles.metaRow}>
                {player.injury_status ? <Badge label={player.injury_status} color={INJURY_COLORS[player.injury_status] ?? colors.textMuted} variant="solid" /> : null}
                {player.nba_team ? <Text style={styles.meta}>{player.nba_team}</Text> : null}
                {eligiblePositions.map(pos => <PosTag key={pos} position={pos} />)}
                {player.dynasty_rank != null ? <Badge label={`Dynasty #${player.dynasty_rank}`} color={colors.textSecondary} textColor={colors.textSecondary} variant="soft" /> : null}
                {player.years_exp != null ? <Badge label={player.years_exp <= 0 ? 'Rookie' : `Yr ${player.years_exp + 1}`} color={colors.textMuted} textColor={colors.textMuted} variant="soft" /> : null}
                {leagueActive ? <Text style={styles.rosterStatus} numberOfLines={1}>{statusLabel}</Text> : null}
            </View>
            {addBlockedReason && addBlockedCaption && rosterStatus?.status === 'free_agent' ? <Text style={styles.pickupCaption} numberOfLines={2}>{addBlockedCaption}</Text> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    header: { gap: spacing.sm },
    identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: controlSize.field.md },
    avatarWrap: { flexShrink: 0 },
    name: { ...textStyles.pageTitle, flex: 1, minWidth: 0 },
    nameCompact: { ...textStyles.rowTitle, fontSize: fontSize.lg },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', alignContent: 'flex-start', gap: spacing.xs, minHeight: textStyles.body.lineHeight },
    meta: { ...textStyles.meta, fontSize: fontSize.sm },
    rosterStatus: { ...textStyles.meta, fontSize: fontSize.xs, maxWidth: spacing['6xl'] * 2 + spacing.xl, minWidth: controlSize.minTouch + spacing['4xl'], backgroundColor: colors.bgMuted, borderRadius: radii.sm, paddingHorizontal: spacing.xs },
    actionWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, width: controlSize.minTouch * 2 + spacing['3xl'], minWidth: controlSize.minTouch * 2 + spacing['3xl'], minHeight: controlSize.minTouch, flexShrink: 0, justifyContent: 'center' },
    action: { minHeight: controlSize.minTouch, width: '100%', paddingHorizontal: spacing.sm, borderRadius: radii.lg, borderCurve: 'continuous', backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
    actionText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    placeholder: { backgroundColor: colors.bgMuted },
    pickupBlocked: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    pickupBlockedText: { color: colors.textPlaceholder },
    pickupCaption: { ...textStyles.meta, minHeight: spacing['4xl'] },
    rosterPrimary: { width: 'auto', flex: 1, paddingHorizontal: spacing.xs },
    dropButton: { minHeight: controlSize.minTouch, minWidth: controlSize.minTouch, paddingHorizontal: spacing.xs, borderWidth: 1, borderColor: colors.primaryBorder, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
    dropText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
