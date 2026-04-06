import {
    View,
    Text,
    Image,
    StyleSheet,
    ActivityIndicator,
    Pressable,
} from 'react-native'
import { useState } from 'react'
import type { PlayerRosterStatus } from '@/lib/roster'
import { POSITION_COLORS } from '@/constants/positions'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'

type Player = {
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
    player: Player
    rosterStatus: PlayerRosterStatus | null
    leagueActive: boolean
    actionLoading: boolean
    playedToday?: boolean
    onAdd: () => void
    onDrop: () => void
    onClaim: () => void
}

export function PlayerHeader({
    player,
    rosterStatus,
    leagueActive,
    actionLoading,
    playedToday = false,
    onAdd,
    onDrop,
    onClaim,
}: Props) {
    const [headshotError, setHeadshotError] = useState(false)
    const eligiblePositions: string[] = player.eligible_positions?.length
        ? player.eligible_positions
        : (player.position ? [player.position] : [])
    const posColor = POSITION_COLORS[eligiblePositions[0] ?? ''] ?? colors.textMuted
    const headshotUri = player.nba_id
        ? `https://cdn.nba.com/headshots/nba/latest/260x190/${player.nba_id}.png`
        : null

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
                    <Avatar name={player.display_name} color={posColor} size={72} />
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
                    {player.injury_status && !playedToday && (
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

            {/* Roster action */}
            {leagueActive && rosterStatus && (
                <View style={styles.actionWrap}>
                    {rosterStatus.status === 'free_agent' ? (
                        <Pressable
                            style={styles.addButton}
                            onPress={onAdd}
                            disabled={actionLoading}
                        >
                            {actionLoading ? (
                                <ActivityIndicator size="small" color={colors.textWhite} />
                            ) : (
                                <Text style={styles.addButtonText}>+ Add</Text>
                            )}
                        </Pressable>
                    ) : rosterStatus.status === 'on_waivers' ? (
                        <Pressable
                            style={styles.claimButton}
                            onPress={onClaim}
                            disabled={actionLoading}
                        >
                            <Text style={styles.claimButtonText}>Claim</Text>
                        </Pressable>
                    ) : rosterStatus.status === 'mine' ? (
                        <Pressable
                            style={styles.dropButton}
                            onPress={onDrop}
                            disabled={actionLoading}
                        >
                            {actionLoading ? (
                                <ActivityIndicator size="small" color={colors.danger} />
                            ) : (
                                <Text style={styles.dropButtonText}>Drop</Text>
                            )}
                        </Pressable>
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
    dropButtonText: { color: colors.danger, fontWeight: fontWeight.bold, fontSize: fontSize.md },

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
