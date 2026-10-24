import { View, Text, Image, StyleSheet, Pressable } from 'react-native'
import { useState, type ReactNode } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { blockedActionProps } from '@/lib/a11y'
import { INJURY_COLORS, colors, fontFamily, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { playerHeadshotUrl } from '@/lib/format'
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
    const headshotSize = compact ? 40 : 64
    const [failedHeadshot, setFailedHeadshot] = useState<string | null>(null)
    const headshotUri = playerHeadshotUrl(player.nba_id)
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
    const busy = primary?.busy || (!rosterStatus && leagueActive) || !actionsReady
    return (
        <View style={styles.header}>
            <View style={styles.identity}>
                {backControl}
                <View style={styles.avatarWrap}>
                    {headshotUri && failedHeadshot !== headshotUri ? (
                        <Image source={{ uri: headshotUri }} style={[styles.headshot, { width: headshotSize, height: headshotSize }]}
                            onError={() => setFailedHeadshot(headshotUri)} />
                    ) : <Avatar name={player.display_name} size={headshotSize} />}
                </View>
                <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={2} accessibilityLabel={player.display_name}>{player.display_name}</Text>
                <View style={styles.actionWrap} aria-busy={busy} accessibilityState={{ busy }} testID="player-action-slot">
                    {primary ? (
                        <Pressable style={[styles.action, primary.blockedReason && styles.pickupBlocked]}
                            onPress={primary.onPress} disabled={primary.disabled || primary.busy}
                            accessibilityRole="button" accessibilityLabel={primary.accessibilityLabel ?? `${primary.label} ${player.display_name}`}
                            {...blockedActionProps(primary.blockedReason ?? null, primary.disabled || primary.busy)}>
                            <Text style={[styles.actionText, primary.blockedReason && styles.pickupBlockedText]} numberOfLines={1}>{primary.label}</Text>
                        </Pressable>
                    ) : <View style={[styles.action, styles.placeholder]} accessibilityLabel={busy ? 'Loading player action' : 'No player action'} />}
                </View>
            </View>
            <View style={styles.metaRow}>
                {player.injury_status ? <Badge label={player.injury_status} color={INJURY_COLORS[player.injury_status] ?? colors.textMuted} variant="solid" /> : null}
                {player.nba_team ? <Text style={styles.meta}>{player.nba_team}</Text> : null}
                {eligiblePositions.map(pos => <PosTag key={pos} position={pos} />)}
                {player.dynasty_rank != null ? <Badge label={`Dynasty #${player.dynasty_rank}`} color={colors.textSecondary} textColor={colors.textSecondary} variant="soft" /> : null}
                {player.years_exp != null ? <Badge label={player.years_exp === 0 ? 'Rookie' : `Yr ${player.years_exp + 1}`} color={colors.textMuted} textColor={colors.textMuted} variant="soft" /> : null}
                {leagueActive ? <Text style={styles.rosterStatus} numberOfLines={1}>{statusLabel}</Text> : null}
            </View>
            {addBlockedReason && addBlockedCaption && rosterStatus?.status === 'free_agent' ? <Text style={styles.pickupCaption} numberOfLines={2}>{addBlockedCaption}</Text> : null}
            {action === undefined && rosterStatus?.status === 'mine' && onDrop ? (
                <Pressable onPress={onDrop} disabled={actionLoading || dropDisabled || !actionsReady} accessibilityRole="button"
                    accessibilityLabel={`Drop ${player.display_name}`} accessibilityState={{ disabled: actionLoading || dropDisabled || !actionsReady }}>
                    <Text style={styles.dropText}>Drop</Text>
                </Pressable>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    header: { gap: spacing.sm },
    identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48 },
    avatarWrap: { flexShrink: 0 },
    headshot: { borderRadius: radii.full, backgroundColor: colors.bgMuted },
    name: { flex: 1, minWidth: 0, fontFamily: fontFamily.display, fontSize: fontSize['2xl'], lineHeight: 28, fontWeight: fontWeight.bold, color: colors.textPrimary },
    nameCompact: { fontSize: fontSize.lg, lineHeight: 22 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', alignContent: 'flex-start', gap: spacing.xs, minHeight: 44 },
    meta: { ...textStyles.meta, fontSize: fontSize.sm },
    rosterStatus: { ...textStyles.meta, fontSize: fontSize.xs, maxWidth: 112, minWidth: 76, backgroundColor: colors.bgMuted, borderRadius: radii.sm, paddingHorizontal: spacing.xs },
    actionWrap: { width: 96, minWidth: 96, minHeight: 44, flexShrink: 0, justifyContent: 'center' },
    action: { minHeight: 44, width: '100%', paddingHorizontal: spacing.sm, borderRadius: radii.lg, borderCurve: 'continuous', backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
    actionText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    placeholder: { backgroundColor: colors.bgMuted },
    pickupBlocked: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    pickupBlockedText: { color: colors.textPlaceholder },
    pickupCaption: { ...textStyles.meta, minHeight: 32 },
    dropText: { ...textStyles.meta, color: colors.dangerDark },
})
