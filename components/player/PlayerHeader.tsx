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

type Props = {
    player: PlayerHeaderPlayer
    rosterStatus: PlayerRosterStatus | null
    claimPending?: boolean
    leagueActive: boolean
    actionsReady?: boolean
    actionLoading: boolean
    dropDisabled?: boolean
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
    claimPending = false,
    leagueActive,
    actionLoading,
    actionsReady = true,
    dropDisabled = false,
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
    const [metadataWidth, setMetadataWidth] = useState(0)
    const [requiredMetadataWidth, setRequiredMetadataWidth] = useState(0)
    const eligiblePositions = getEligiblePositions(player)
    const headshotUri = playerHeadshotUrl(player.nba_id)
    const showExperience = player.years_exp != null && (!compact || metadataWidth - requiredMetadataWidth >= EXPERIENCE_WIDTH + spacing.xs)

    function renderPickupAction({ label, accessibilityLabel, buttonStyle, textStyle, onPress, blockedReason }: {
        label: string
        accessibilityLabel: string
        buttonStyle: StyleProp<ViewStyle>
        textStyle: StyleProp<TextStyle>
        onPress: () => void
        blockedReason: string | null
    }) {
        return (
            <Pressable
                style={[buttonStyle, blockedReason ? styles.pickupBlocked : null]}
                onPress={onPress}
                disabled={actionLoading || !actionsReady}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                {...blockedActionProps(blockedReason, actionLoading || !actionsReady)}
            >
                <Text style={[textStyle, blockedReason ? styles.pickupBlockedText : null]}>{label}</Text>
            </Pressable>
        )
    }

    const statusLabel = rosterStatus?.status === 'free_agent' ? 'Free agent'
        : rosterStatus?.status === 'on_waivers' ? 'On waivers'
        : rosterStatus?.status === 'mine' ? 'On your roster'
        : rosterStatus?.status === 'taken' ? rosterStatus.ownerTeamName
        : 'Roster status'

    return (
        <View style={styles.header}>
            <View style={styles.identity}>
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
                    <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={compact ? 1 : 2} accessibilityLabel={player.display_name}>{player.display_name}</Text>
                    <View style={styles.metaRow} onLayout={event => setMetadataWidth(event.nativeEvent.layout.width)}>
                        <View style={styles.requiredMetadata} onLayout={event => setRequiredMetadataWidth(event.nativeEvent.layout.width)}>
                            {player.nba_team ? <Text style={styles.meta}>{player.nba_team}</Text> : null}
                            {eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                            {player.dynasty_rank != null ? (
                                <Badge label={`Dynasty #${player.dynasty_rank}`} color={colors.textSecondary} textColor={colors.textSecondary} variant="soft" />
                            ) : null}
                            {player.injury_status ? (
                                <Badge
                                    label={player.injury_status}
                                    color={INJURY_COLORS[player.injury_status] ?? colors.textMuted}
                                    variant="solid"
                                />
                            ) : null}
                        </View>
                        {showExperience ? (
                            <Badge
                                label={player.years_exp === 0 ? 'Rookie' : `Yr ${(player.years_exp ?? 0) + 1}`}
                                color={player.years_exp === 0 ? colors.success : colors.textMuted}
                                textColor={player.years_exp === 0 ? colors.success : colors.textMuted}
                                variant="soft"
                                maxWidth={EXPERIENCE_WIDTH}
                            />
                        ) : null}
                    </View>
                    {leagueActive && (
                        <View style={styles.rosterRow}>
                            <Text style={styles.rosterStatus} numberOfLines={1}>{statusLabel}</Text>
                            <View style={styles.actionWrap} aria-busy={!actionsReady} accessibilityState={{ busy: !actionsReady }}>
                                {!rosterStatus ? null : rosterStatus.status === 'free_agent' ? (
                                    renderPickupAction({ label: 'Add', accessibilityLabel: `Add ${player.display_name}`, buttonStyle: [styles.action, styles.actionPrimary], textStyle: styles.actionPrimaryText, onPress: onAdd, blockedReason: addBlockedReason })
                                ) : rosterStatus.status === 'on_waivers' ? (
                                    renderPickupAction({ label: claimPending ? 'Claim pending' : 'Claim', accessibilityLabel: claimPending ? `Claim pending for ${player.display_name}, view claims` : `Claim ${player.display_name}`, buttonStyle: [styles.action, styles.actionClaim], textStyle: [styles.actionPrimaryText, styles.actionClaimText], onPress: onClaim, blockedReason: null })
                                ) : rosterStatus.status === 'mine' ? (
                                    <View style={styles.myActions}>
                                        <Pressable
                                            style={[styles.action, styles.actionPrimary]}
                                            onPress={onSetLineup}
                                            disabled={actionLoading || !actionsReady}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Move ${player.display_name} in lineup`}
                                            accessibilityState={{ disabled: actionLoading || !actionsReady }}
                                        >
                                            <Text style={styles.actionPrimaryText}>Lineup</Text>
                                        </Pressable>
                                        <Pressable
                                            style={[styles.action, styles.actionDanger, dropDisabled && { opacity: 0.5 }]}
                                            onPress={onDrop}
                                            disabled={actionLoading || dropDisabled || !actionsReady}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Drop ${player.display_name}`}
                                            accessibilityState={{ disabled: actionLoading || dropDisabled || !actionsReady }}
                                        >
                                            <Text style={styles.actionDangerText}>Drop</Text>
                                        </Pressable>
                                    </View>
                                ) : null}
                            </View>
                        </View>
                    )}
                    {leagueActive && rosterStatus?.status === 'free_agent' && addBlockedReason && addBlockedCaption ? (
                        <Text style={styles.pickupCaption} numberOfLines={2}>{addBlockedCaption}</Text>
                    ) : null}
                </View>
            </View>
        </View>
    )
}

const HEADSHOT = 64
const HEADSHOT_COMPACT = 48
const EXPERIENCE_WIDTH = 60

const styles = StyleSheet.create({
    header: { gap: spacing.md },
    identity: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    rosterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginTop: spacing.xs },
    rosterStatus: { ...textStyles.meta, flex: 1 },
    avatarWrap: { flexShrink: 0 },
    headshot: { borderRadius: radii.full, backgroundColor: colors.bgMuted },

    info: { flex: 1, minWidth: 0, gap: spacing.xs },
    name: { fontFamily: fontFamily.display, fontSize: fontSize['2xl'], lineHeight: 28, fontWeight: fontWeight.bold, color: colors.textPrimary },
    nameCompact: { fontSize: fontSize.xl, lineHeight: 24 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 20, overflow: 'hidden' },
    requiredMetadata: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 0 },
    meta: { ...textStyles.meta, fontSize: fontSize.sm },

    actionWrap: { minWidth: 76, minHeight: 44, flexShrink: 0, justifyContent: 'center' },
    myActions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'stretch' },
    pickupBlocked: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight },
    pickupBlockedText: { color: colors.textPlaceholder },
    pickupCaption: { fontSize: fontSize.xs, color: colors.textMuted },

    action: {
        minHeight: 44,
        minWidth: 76,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionPrimary: { backgroundColor: colors.primary },
    actionClaim: { backgroundColor: colors.info },
    actionClaimText: { color: colors.onAccent },
    actionDanger: { borderWidth: 1, borderColor: colors.danger },
    actionPrimaryText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    actionDangerText: { color: colors.dangerDark, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
})
