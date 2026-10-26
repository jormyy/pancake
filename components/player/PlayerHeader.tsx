import { PlayerEligibilityTags } from './PlayerEligibilityTags'
import { View, Text, StyleSheet, Pressable } from 'react-native'
import type { ReactNode } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { blockedActionProps } from '@/lib/a11y'
import { colors, controlSize, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
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
    career_regular_season_games?: number | null
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
    ownTeamName?: string | null
    action?: PlayerHeaderAction | null
    backControl?: ReactNode
    leagueActive: boolean
    actionsReady?: boolean
    dropDisabled?: boolean
    onDrop?: () => void
    compact?: boolean
}

export function PlayerHeader({ player, rosterStatus, ownTeamName, action, backControl,
    leagueActive, actionsReady = true, dropDisabled = false, onDrop, compact = false }: Props) {
    const headshotSize = compact ? controlSize.avatar.md : controlSize.avatar.lg
    const eligiblePositions = getEligiblePositions(player)
    const statusLabel = rosterStatus?.status === 'free_agent' ? 'Free agent'
        : rosterStatus?.status === 'on_waivers' ? 'On waivers'
        : rosterStatus?.status === 'mine' ? ownTeamName ?? 'On your roster'
        : rosterStatus?.status === 'taken' ? rosterStatus.ownerTeamName : ' '
    const showDrop = rosterStatus?.status === 'mine' && onDrop != null
    const busy = action?.busy || (!rosterStatus && leagueActive) || !actionsReady
    return (
        <View style={styles.header}>
            <View style={styles.identity}>
                {backControl}
                <View style={styles.avatarWrap}>
                    <PlayerAvatar name={player.display_name} nbaId={player.nba_id} size={headshotSize} />
                </View>
                <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={1} accessibilityLabel={player.display_name}>{player.display_name}</Text>
                <View style={styles.actionWrap} aria-busy={busy} accessibilityState={{ busy }} testID="player-action-slot">
                    {action ? (
                        <Pressable style={[styles.action, showDrop && styles.rosterPrimary, action.blockedReason && styles.pickupBlocked]}
                            onPress={action.onPress} disabled={action.disabled || action.busy}
                            accessibilityRole="button" accessibilityLabel={action.accessibilityLabel ?? `${action.label} ${player.display_name}`}
                            {...blockedActionProps(action.blockedReason ?? null, action.disabled || action.busy)}>
                            <Text style={[styles.actionText, action.blockedReason && styles.pickupBlockedText]} numberOfLines={1}>{action.label}</Text>
                        </Pressable>
                    ) : <View style={[styles.action, showDrop && styles.rosterPrimary, styles.placeholder]} accessibilityLabel={busy ? 'Loading player action' : 'No player action'} />}
                    {showDrop ? (
                        <Pressable style={styles.dropButton} onPress={onDrop} disabled={action?.busy || dropDisabled || !actionsReady}
                            accessibilityRole="button" accessibilityLabel={`Drop ${player.display_name}`}
                            accessibilityState={{ disabled: action?.busy || dropDisabled || !actionsReady }}>
                            <Text style={styles.dropText}>Drop</Text>
                        </Pressable>
                    ) : null}
                </View>
            </View>
            <View style={styles.metaRow} testID="player-position-line">
                {player.nba_team ? <Text style={styles.meta}>{player.nba_team}</Text> : null}
                {eligiblePositions.map(pos => <PosTag key={pos} position={pos} />)}
                <PlayerEligibilityTags yearsExp={player.years_exp} careerGames={player.career_regular_season_games} injuryStatus={player.injury_status} onTaxi={rosterStatus?.status === 'mine' || rosterStatus?.status === 'taken' ? rosterStatus.isOnTaxi : false} />
            </View>
            <View style={styles.summaryRow} testID="player-summary-line">
                {player.dynasty_rank != null ? <Badge inline label={`Dynasty #${player.dynasty_rank}`} color={colors.textSecondary} textColor={colors.textSecondary} variant="soft" /> : null}
                {player.years_exp != null ? <Badge inline label={`Yr ${player.years_exp + 1}`} color={colors.textMuted} /> : null}
                {leagueActive ? <Text style={styles.rosterStatus} numberOfLines={1}>{statusLabel}</Text> : null}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    header: { gap: spacing.sm },
    identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: controlSize.field.md },
    avatarWrap: { flexShrink: 0 },
    name: { ...textStyles.pageTitle, flex: 1, minWidth: 0 },
    nameCompact: { ...textStyles.rowTitle, fontSize: fontSize.lg },
    metaRow: { flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: spacing.xs, minHeight: textStyles.body.lineHeight },
    summaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: textStyles.body.lineHeight },
    meta: { ...textStyles.meta, fontSize: fontSize.sm },
    rosterStatus: { ...textStyles.meta, fontSize: fontSize.xs, maxWidth: spacing['6xl'] * 2 + spacing.xl, flexShrink: 1, backgroundColor: colors.bgMuted, borderRadius: radii.sm, paddingHorizontal: spacing.xs },
    actionWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, width: controlSize.minTouch * 2 + spacing['3xl'], minWidth: controlSize.minTouch * 2 + spacing['3xl'], minHeight: controlSize.minTouch, flexShrink: 0, justifyContent: 'center' },
    action: { minHeight: controlSize.minTouch, width: '100%', paddingHorizontal: spacing.sm, borderRadius: radii.lg, borderCurve: 'continuous', backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
    actionText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    placeholder: { backgroundColor: colors.bgMuted },
    pickupBlocked: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    pickupBlockedText: { color: colors.textPlaceholder },
    rosterPrimary: { width: 'auto', flex: 1, paddingHorizontal: spacing.xs },
    dropButton: { minHeight: controlSize.minTouch, minWidth: controlSize.minTouch, paddingHorizontal: spacing.xs, borderWidth: 1, borderColor: colors.primaryBorder, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
    dropText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
})
