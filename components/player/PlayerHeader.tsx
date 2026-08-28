import {
    View,
    Text,
    Image,
    StyleSheet,
    Pressable,
    type StyleProp,
    type TextStyle,
    type ViewStyle,
} from 'react-native'
import { useState } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { blockedActionProps } from '@/lib/a11y'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { playerHeadshotUrl } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'

export type PlayerHeaderPlayer = {
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

type Props = {
    player: PlayerHeaderPlayer
    rosterStatus: PlayerRosterStatus | null
    leagueActive: boolean
    actionLoading: boolean
    playedToday?: boolean
    /** Why a free-agent add is unavailable (weekly add limit); the action stays pressable so a tap explains it. A claim is gated by the claim modal. */
    addBlockedReason?: string | null
    /** One-line caption shown under the blocked action, e.g. "Adds 7/7 · resets Mon, Nov 2 at 12:00 AM ET". */
    addBlockedCaption?: string | null
    onAdd: () => void
    onDrop: () => void
    onClaim: () => void
    onSetLineup: () => void
}

export function PlayerHeader({
    player,
    rosterStatus,
    leagueActive,
    actionLoading,
    playedToday = false,
    addBlockedReason = null,
    addBlockedCaption = null,
    onAdd,
    onDrop,
    onClaim,
    onSetLineup,
}: Props) {
    const [headshotError, setHeadshotError] = useState(false)
    const eligiblePositions = getEligiblePositions(player)
    const headshotUri = playerHeadshotUrl(player.nba_id)

    function renderPickupAction(
        label: string,
        accessibilityLabel: string,
        buttonStyle: StyleProp<ViewStyle>,
        textStyle: StyleProp<TextStyle>,
        onPress: () => void,
        blockedReason: string | null,
    ) {
        return (
            <View style={styles.pickupAction}>
                <Pressable
                    style={[buttonStyle, blockedReason ? styles.pickupBlocked : null]}
                    onPress={onPress}
                    disabled={actionLoading}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                    {...blockedActionProps(blockedReason, actionLoading)}
                >
                    <Text style={[textStyle, blockedReason ? styles.pickupBlockedText : null]}>{label}</Text>
                </Pressable>
                {blockedReason && addBlockedCaption ? (
                    <Text style={styles.pickupCaption} numberOfLines={2}>{addBlockedCaption}</Text>
                ) : null}
            </View>
        )
    }

    const metaParts = [
        player.jersey_number ? `#${player.jersey_number}` : null,
        player.nba_team,
    ].filter(Boolean)

    return (
        <View style={styles.header}>
            {/* Avatar */}
            <View style={styles.avatarWrap}>
                {headshotUri && !headshotError ? (
                    <Image
                        source={{ uri: headshotUri }}
                        style={styles.headshot}
                        onError={() => setHeadshotError(true)}
                    />
                ) : (
                    <Avatar name={player.display_name} size={72} />
                )}
            </View>

            {/* Info */}
            <View style={styles.info}>
                <Text style={styles.name}>{player.display_name}</Text>
                <View style={styles.metaRow}>
                    {metaParts.length > 0 && <Text style={styles.meta}>{metaParts.join(' · ')}</Text>}
                    {eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                </View>
                <View style={styles.badges}>
                    {player.injury_status && (
                        <Badge
                            label={player.injury_status}
                            color={INJURY_COLORS[player.injury_status] ?? colors.textMuted}
                            variant="solid"
                        />
                    )}
                    {player.dynasty_rank != null && (
                        <Badge
                            label={`Dynasty rank #${player.dynasty_rank}`}
                            color={colors.textSecondary}
                            variant="soft"
                            textColor={colors.textSecondary}
                        />
                    )}
                    {player.years_exp != null && (
                        <Badge
                            label={player.years_exp === 0 ? 'Rookie' : `Yr ${player.years_exp + 1}`}
                            color={player.years_exp === 0 ? colors.success : colors.textMuted}
                            variant="soft"
                            textColor={player.years_exp === 0 ? colors.success : colors.textMuted}
                        />
                    )}
                </View>
            </View>

            {/* Roster action */}
            {leagueActive && rosterStatus && (
                <View style={styles.actionWrap}>
                    {rosterStatus.status === 'free_agent' ? (
                        renderPickupAction('+ Add', `Add ${player.display_name}`, styles.addButton, styles.addButtonText, onAdd, addBlockedReason)
                    ) : rosterStatus.status === 'on_waivers' ? (
                        renderPickupAction('Claim', `Claim ${player.display_name}`, styles.claimButton, styles.claimButtonText, onClaim, null)
                    ) : rosterStatus.status === 'mine' ? (
                        <View style={styles.myActions}>
                            <Pressable
                                style={styles.lineupButton}
                                onPress={onSetLineup}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Move ${player.display_name} in lineup`}
                                accessibilityState={{ disabled: actionLoading }}
                            >
                                <Text style={styles.lineupButtonText}>Lineup</Text>
                            </Pressable>
                            <Pressable
                                style={styles.dropButton}
                                onPress={onDrop}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Drop ${player.display_name}`}
                                accessibilityState={{ disabled: actionLoading }}
                            >
                                <Text style={styles.dropButtonText}>Drop</Text>
                            </Pressable>
                        </View>
                    ) : (
                        <View style={styles.takenBadge}>
                            <Text style={styles.takenText}>
                                {rosterStatus.ownerTeamName}
                            </Text>
                        </View>
                    )}
                </View>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    avatarWrap: { flexShrink: 0 },
    headshot: { width: 72, height: 72, borderRadius: radii.full, backgroundColor: colors.bgMuted },

    info: { flex: 1, gap: spacing.xs },
    name: { fontSize: fontSize['2xl'] - 2, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    meta: { fontSize: fontSize.md, color: colors.textMuted },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },

    actionWrap: { flexShrink: 0 },
    myActions: { gap: spacing.sm, alignItems: 'stretch' },
    pickupAction: { alignItems: 'flex-end', gap: spacing.xs, maxWidth: 160 },
    pickupBlocked: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    pickupBlockedText: { color: colors.textPlaceholder },
    pickupCaption: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'right' },

    lineupButton: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        minWidth: 72,
        alignItems: 'center',
    },
    lineupButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },

    addButton: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.lg + 2,
        paddingVertical: spacing.md + 1,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        minWidth: 68,
        alignItems: 'center',
    },
    addButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },

    dropButton: {
        paddingHorizontal: spacing.lg + 2,
        paddingVertical: spacing.md + 1,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.danger,
        minWidth: 68,
        alignItems: 'center',
    },
    dropButtonText: { color: colors.dangerDark, fontWeight: fontWeight.bold, fontSize: fontSize.md },

    claimButton: {
        backgroundColor: colors.info,
        paddingHorizontal: spacing.lg + 2,
        paddingVertical: spacing.md + 1,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        minWidth: 68,
        alignItems: 'center',
    },
    claimButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },

    takenBadge: {
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.lg - 2,
        paddingVertical: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
    },
    takenText: { color: colors.textMuted, fontSize: fontSize.sm - 1, fontWeight: fontWeight.semibold },
})
