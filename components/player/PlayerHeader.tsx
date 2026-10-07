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
import { INJURY_COLORS, colors, controlSize, fontFamily, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
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
    /** Smaller headshot so the name keeps room next to the actions on phones. */
    compact?: boolean
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
    compact = false,
}: Props) {
    const headshotSize = compact ? HEADSHOT_COMPACT : HEADSHOT
    const [headshotError, setHeadshotError] = useState(false)
    const eligiblePositions = getEligiblePositions(player)
    const headshotUri = playerHeadshotUrl(player.nba_id)

    function renderPickupAction({ label, accessibilityLabel, buttonStyle, textStyle, onPress, blockedReason }: {
        label: string
        accessibilityLabel: string
        buttonStyle: StyleProp<ViewStyle>
        textStyle: StyleProp<TextStyle>
        onPress: () => void
        blockedReason: string | null
    }) {
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
            <View style={styles.avatarWrap}>
                {headshotUri && !headshotError ? (
                    <Image
                        source={{ uri: headshotUri }}
                        style={[styles.headshot, { width: headshotSize, height: headshotSize }]}
                        onError={() => setHeadshotError(true)}
                    />
                ) : (
                    <Avatar name={player.display_name} size={headshotSize} />
                )}
            </View>

            <View style={styles.info}>
                <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={2}>{player.display_name}</Text>
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
                            label={`Dynasty #${player.dynasty_rank}`}
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

            {leagueActive && rosterStatus && (
                <View style={styles.actionWrap}>
                    {rosterStatus.status === 'free_agent' ? (
                        renderPickupAction({ label: 'Add', accessibilityLabel: `Add ${player.display_name}`, buttonStyle: [styles.action, styles.actionPrimary], textStyle: styles.actionPrimaryText, onPress: onAdd, blockedReason: addBlockedReason })
                    ) : rosterStatus.status === 'on_waivers' ? (
                        renderPickupAction({ label: 'Claim', accessibilityLabel: `Claim ${player.display_name}`, buttonStyle: [styles.action, styles.actionClaim], textStyle: styles.actionPrimaryText, onPress: onClaim, blockedReason: null })
                    ) : rosterStatus.status === 'mine' ? (
                        <View style={styles.myActions}>
                            <Pressable
                                style={[styles.action, styles.actionPrimary]}
                                onPress={onSetLineup}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Move ${player.display_name} in lineup`}
                                accessibilityState={{ disabled: actionLoading }}
                            >
                                <Text style={styles.actionPrimaryText}>Lineup</Text>
                            </Pressable>
                            <Pressable
                                style={[styles.action, styles.actionDanger]}
                                onPress={onDrop}
                                disabled={actionLoading}
                                accessibilityRole="button"
                                accessibilityLabel={`Drop ${player.display_name}`}
                                accessibilityState={{ disabled: actionLoading }}
                            >
                                <Text style={styles.actionDangerText}>Drop</Text>
                            </Pressable>
                        </View>
                    ) : (
                        <View style={styles.takenBadge}>
                            <Text style={styles.takenText} numberOfLines={2}>
                                {rosterStatus.ownerTeamName}
                            </Text>
                        </View>
                    )}
                </View>
            )}
        </View>
    )
}

const HEADSHOT = 64
const HEADSHOT_COMPACT = 48

const styles = StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    avatarWrap: { flexShrink: 0 },
    headshot: { borderRadius: radii.full, backgroundColor: colors.bgMuted },

    info: { flex: 1, minWidth: 0, gap: spacing.xs },
    name: { fontFamily: fontFamily.display, fontSize: fontSize['2xl'], lineHeight: 28, fontWeight: fontWeight.bold, color: colors.textPrimary },
    nameCompact: { fontSize: fontSize.xl, lineHeight: 24 },
    metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs },
    meta: { ...textStyles.meta, fontSize: fontSize.sm },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },

    actionWrap: { flexShrink: 0, alignSelf: 'flex-start' },
    myActions: { gap: spacing.sm, alignItems: 'stretch' },
    pickupAction: { alignItems: 'flex-end', gap: spacing.xs, maxWidth: 160 },
    pickupBlocked: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    pickupBlockedText: { color: colors.textPlaceholder },
    pickupCaption: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'right' },

    action: {
        minHeight: controlSize.button.sm.height,
        minWidth: 76,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionPrimary: { backgroundColor: colors.primary },
    actionClaim: { backgroundColor: colors.info },
    actionDanger: { borderWidth: 1, borderColor: colors.danger },
    actionPrimaryText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    actionDangerText: { color: colors.dangerDark, fontWeight: fontWeight.bold, fontSize: fontSize.sm },

    takenBadge: {
        maxWidth: 140,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
    },
    takenText: { color: colors.textMuted, fontSize: fontSize['2sm'], fontWeight: fontWeight.semibold, textAlign: 'center' },
})
