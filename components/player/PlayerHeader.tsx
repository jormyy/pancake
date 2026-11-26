import { LockedAssetNotice, LockedActionExplanation } from '@/components/roster/LockedAssetNotice'
import type { AssetLock } from '@/lib/locked-assets'
import { Button } from '@/components/ui/Button'
import { PlayerDetailsLine } from './PlayerDetailsLine'
import { InjuryTag } from '@/components/InjuryTag'
import { View, Text, StyleSheet } from 'react-native'
import type { ReactNode } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { blockedActionProps } from '@/lib/a11y'
import { borderWidth, colors, componentTokens, controlSize, radii, spacing, textStyles, typeScale } from '@/constants/tokens'
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

export function playerSummaryLine(player: Pick<PlayerHeaderPlayer, 'dynasty_rank' | 'birthdate' | 'years_exp'>) {
    const age = playerAgeDecimal(player.birthdate)
    return [
        player.dynasty_rank != null ? `Dynasty #${player.dynasty_rank}` : null,
        age != null ? `Age: ${age.toFixed(1)}` : null,
        player.years_exp === 0 ? 'Rookie' : player.years_exp != null ? `Yr ${player.years_exp + 1}` : null,
    ].filter(Boolean).join(' · ')
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
    showSummary?: boolean
    padX?: number
    detail?: ReactNode
}

const TAXI_CAREER_GAME_LIMIT = 65

export function taxiStatusLine(player: Pick<PlayerHeaderPlayer, 'years_exp' | 'career_regular_season_games'>, taxiSlots: number) {
    if (taxiSlots <= 0) return null
    const games = player.career_regular_season_games ?? null
    if (player.years_exp === 0) return games ? `Taxi eligible · rookie · ${games} games` : 'Taxi eligible · rookie'
    if (games == null) return null
    return games < TAXI_CAREER_GAME_LIMIT
        ? `Taxi eligible · ${games} of ${TAXI_CAREER_GAME_LIMIT} games`
        : `Not taxi eligible · ${games} games`
}

export function playerAvailability(rosterStatus: Props['rosterStatus'], ownTeamName?: string | null) {
    const label = rosterStatus?.status === 'free_agent' ? 'Free agent'
        : rosterStatus?.status === 'on_waivers' ? 'On waivers'
        : rosterStatus?.status === 'mine' ? ownTeamName ?? 'On your roster'
        : rosterStatus?.status === 'taken' ? rosterStatus.ownerTeamName : null
    const onTaxi = (rosterStatus?.status === 'mine' || rosterStatus?.status === 'taken') && rosterStatus.isOnTaxi === true
    const tone = rosterStatus?.status === 'free_agent' ? colors.success
        : rosterStatus?.status === 'on_waivers' ? colors.warningDark
        : rosterStatus?.status === 'mine' ? colors.primaryDark : colors.textSecondary
    return { label: label && onTaxi ? `${label} · Taxi squad` : label, tone }
}

export function PlayerHeader({ locks = [], player, rosterStatus, ownTeamName, action, backControl,
    leagueActive, actionsReady = true, dropDisabled = false, onDrop, compact = false, showSummary = true,
    padX = spacing.none, detail }: Props) {
    const headshotSize = compact ? controlSize.avatar.md : controlSize.avatar.lg
    const eligiblePositions = getEligiblePositions(player)
    const summary = playerSummaryLine(player)
    const showDrop = rosterStatus?.status === 'mine' && onDrop != null
    const busy = action?.busy || (!rosterStatus && leagueActive) || !actionsReady
    return (
        <View style={[styles.header, { paddingHorizontal: padX }]}>
            <View style={styles.identity}>
                {backControl}
                <View style={styles.avatarWrap}>
                    <PlayerAvatar name={player.display_name} nbaId={player.nba_id} size={headshotSize} />
                    <InjuryTag status={player.injury_status} avatarSize={headshotSize} />
                </View>
                <View style={styles.identityCopy}>
                    <Text style={[styles.name, compact && styles.nameCompact]} accessibilityLabel={player.display_name}>{player.display_name}</Text>
                    <View style={styles.metaRow} testID="player-position-line">
                        <PlayerDetailsLine team={player.nba_team} positions={eligiblePositions} jersey={player.jersey_number} />
                        <LockedAssetNotice locks={locks} />
                    </View>
                </View>
                {leagueActive ? (
                    <View style={styles.actionWrap} aria-busy={busy} accessibilityState={{ busy }} testID="player-action-slot">
                        {action ? (
                            <Button size="sm" title={action.label}
                                variant={action.blockedReason ? 'secondary' : 'primary'}
                                labelStyle={action.blockedReason ? { color: colors.textPlaceholder } : undefined}
                                onPress={action.onPress} disabled={action.disabled || action.busy}
                                accessibilityLabel={action.accessibilityLabel ?? `${action.label} ${player.display_name}`}
                                {...blockedActionProps(action.blockedReason ?? null, action.disabled || action.busy)} />
                        ) : <View style={styles.placeholder} accessibilityLabel={busy ? 'Loading player action' : 'No player action'} />}
                        {showDrop ? (
                            <LockedActionExplanation locks={locks} label={`Drop ${player.display_name}`} busy={Boolean(action?.busy || dropDisabled || !actionsReady)}>
                            <Button size="sm" title="Drop" variant="outline" onPress={onDrop}
                                disabled={action?.busy || dropDisabled || !actionsReady || locks.length > 0}
                                accessibilityLabel={`Drop ${player.display_name}`} /></LockedActionExplanation>
                        ) : null}
                    </View>
                ) : null}
            </View>
            {showSummary ? (
                <View style={styles.summaryRow} testID="player-summary-line">
                    <Text style={styles.summary} numberOfLines={1}>{summary}</Text>
                </View>
            ) : null}
            {detail}
        </View>
    )
}

const styles = StyleSheet.create({
    header: {
        gap: spacing.xs,
        paddingVertical: spacing.sm,
        backgroundColor: colors.bgCard,
        borderBottomWidth: borderWidth.thin,
        borderBottomColor: colors.borderLight,
    },
    identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: controlSize.field.md },
    avatarWrap: { flexShrink: 0 },
    identityCopy: { flex: 1, minWidth: 0, gap: spacing.xxs },
    name: { ...textStyles.pageTitle, flexShrink: 1 },
    nameCompact: { ...textStyles.rowTitle, ...typeScale.title },
    metaRow: { flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: spacing.xs, minHeight: textStyles.body.lineHeight },
    summary: { ...componentTokens.playerRow.metadata, color: colors.textSecondary, flexShrink: 1, minWidth: 0 },
    summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, minHeight: textStyles.body.lineHeight },
    actionWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: controlSize.minTouch * 2, minHeight: controlSize.minTouch, flexShrink: 0, justifyContent: 'flex-end' },
    placeholder: { height: controlSize.button.sm.height, width: controlSize.minTouch * 2, backgroundColor: colors.bgMuted, borderRadius: radii.md },
})
