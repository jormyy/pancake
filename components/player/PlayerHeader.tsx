import { LockedAssetNotice, LockedActionExplanation } from '@/components/roster/LockedAssetNotice'
import type { AssetLock } from '@/lib/locked-assets'
import { Button } from '@/components/ui/Button'
import { PlayerDetailsLine } from './PlayerDetailsLine'
import { InjuryTag } from '@/components/InjuryTag'
import { View, Text, StyleSheet } from 'react-native'
import type { ReactNode } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { blockedActionProps } from '@/lib/a11y'
import { colors, componentTokens, controlSize, radii, spacing, textStyles, typeScale } from '@/constants/tokens'
import { playerAgeDecimal } from '@/lib/player-context'
import { PlayerAvatar } from './PlayerAvatar'
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
    birthdate?: string | null
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
    locks?: readonly AssetLock[]
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

export function PlayerHeader({ locks = [], player, rosterStatus, ownTeamName, action, backControl,
    leagueActive, actionsReady = true, dropDisabled = false, onDrop, compact = false }: Props) {
    const headshotSize = compact ? controlSize.avatar.md : controlSize.avatar.lg
    const eligiblePositions = getEligiblePositions(player)
    const age = playerAgeDecimal(player.birthdate)
    const summary = [
        player.dynasty_rank != null ? `Dynasty #${player.dynasty_rank}` : null,
        age != null ? `Age: ${age.toFixed(1)}` : null,
        player.years_exp === 0 ? 'Rookie' : player.years_exp != null ? `Yr ${player.years_exp + 1}` : null,
    ].filter(Boolean).join(' · ')
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
                    <InjuryTag status={player.injury_status} avatarSize={headshotSize} />
                </View>
                <Text style={[styles.name, compact && styles.nameCompact]} accessibilityLabel={player.display_name}>{player.display_name}</Text>
                <View style={styles.actionWrap} aria-busy={busy} accessibilityState={{ busy }} testID="player-action-slot">
                    {action ? (
                        <Button size="inline" title={action.label}
                            variant={action.blockedReason ? 'secondary' : 'primary'}
                            labelStyle={action.blockedReason ? { color: colors.textPlaceholder } : undefined}
                            onPress={action.onPress} disabled={action.disabled || action.busy}
                            accessibilityLabel={action.accessibilityLabel ?? `${action.label} ${player.display_name}`}
                            {...blockedActionProps(action.blockedReason ?? null, action.disabled || action.busy)} />
                    ) : <View style={styles.placeholder} accessibilityLabel={busy ? 'Loading player action' : 'No player action'} />}
                    {showDrop ? (
                        <LockedActionExplanation locks={locks} label={`Drop ${player.display_name}`} busy={Boolean(action?.busy || dropDisabled || !actionsReady)}>
                        <Button size="inline" title="Drop" variant="outline" onPress={onDrop}
                            disabled={action?.busy || dropDisabled || !actionsReady || locks.length > 0}
                            accessibilityLabel={`Drop ${player.display_name}`} /></LockedActionExplanation>
                    ) : null}
                </View>
            </View>
            <View style={styles.metaRow} testID="player-position-line">
                <PlayerDetailsLine team={player.nba_team} positions={eligiblePositions} jersey={player.jersey_number} />
            </View>
            <View style={styles.summaryRow} testID="player-summary-line">
                {summary ? <Text style={styles.summary} numberOfLines={1}>{summary}</Text> : null}
                <LockedAssetNotice locks={locks} />
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
    nameCompact: { ...textStyles.rowTitle, fontSize: componentTokens.pageHeader.compact.title.fontSize },
    metaRow: { flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: spacing.xs, minHeight: textStyles.body.lineHeight },
    summary: { ...componentTokens.playerRow.metadata, color: colors.textSecondary, flexShrink: 1, minWidth: 0 },
    summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, minHeight: textStyles.body.lineHeight },
    rosterStatus: { ...textStyles.meta, ...typeScale.caption, maxWidth: spacing['6xl'] * 2 + spacing.xl, flexShrink: 1, backgroundColor: colors.bgMuted, borderRadius: radii.sm, paddingHorizontal: spacing.xs },
    actionWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, width: controlSize.minTouch * 2 + spacing['3xl'], minWidth: controlSize.minTouch * 2 + spacing['3xl'], minHeight: controlSize.minTouch, flexShrink: 0, justifyContent: 'flex-end' },
    placeholder: { height: controlSize.button.inline.height, width: controlSize.minTouch, backgroundColor: colors.bgMuted, borderRadius: radii.md },
})
