import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { ComponentProps } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { Sheet } from '@/components/ui/Sheet'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { formatPoints, playerHeadshotUrl } from '@/lib/format'
import { getEligiblePositions } from '@/lib/players'
import type { RosterPlayer } from '@/lib/roster'
import type { RosterAverage } from '@/lib/roster-stats'

type IconName = ComponentProps<typeof MaterialIcons>['name']
type PressableState = { hovered?: boolean; pressed?: boolean }

export type RosterSheetAction = {
    key: string
    label: string
    icon: IconName
    onPress: () => void
    tone?: 'default' | 'danger'
    accessibilityLabel?: string
}

function statCells(avgFpts: number | undefined, stats: RosterAverage | undefined): [string, string][] {
    const fmt = (value: number | null | undefined) => (value == null ? '—' : formatPoints(value))
    return [
        ['FP', fmt(avgFpts)],
        ['MIN', fmt(stats?.avg_minutes_played)],
        ['PTS', fmt(stats?.avg_points)],
        ['REB', fmt(stats?.avg_rebounds)],
        ['AST', fmt(stats?.avg_assists)],
        ['STL', fmt(stats?.avg_steals)],
        ['BLK', fmt(stats?.avg_blocks)],
        ['3PM', fmt(stats?.avg_three_pointers_made)],
        ['TO', fmt(stats?.avg_turnovers)],
        ['GP', stats?.games_played == null ? '—' : String(Math.round(stats.games_played))],
    ]
}

/**
 * Everything you can do with one of your players, one tap from the roster:
 * season averages up top, then each action that applies to this player.
 */
export function RosterPlayerSheet({
    player,
    avgFpts,
    stats,
    actions,
    onClose,
}: {
    player: RosterPlayer | null
    avgFpts?: number
    stats?: RosterAverage
    actions: RosterSheetAction[]
    onClose: () => void
}) {
    const info = player?.players
    const positions = info ? getEligiblePositions(info) : []
    const status = player?.is_on_ir ? 'On IR' : player?.is_on_taxi ? 'Taxi squad' : null

    return (
        <Sheet visible={player != null} onClose={onClose} title={info?.display_name ?? 'Player'}>
            {info ? (
                <View style={styles.body}>
                    <View style={styles.identity}>
                        <Avatar
                            name={info.display_name}
                            uri={playerHeadshotUrl(info.nba_id) ?? undefined}
                            color={colors.bgMuted}
                            textColor={colors.textSecondary}
                            size={48}
                        />
                        <View style={styles.identityText}>
                            <View style={styles.metaRow}>
                                {info.nba_team ? <Text style={textStyles.meta}>{info.nba_team}</Text> : null}
                                {positions.map((pos) => <PosTag key={pos} position={pos} />)}
                                {info.injury_status ? (
                                    <Badge
                                        label={info.injury_status}
                                        color={INJURY_COLORS[info.injury_status] ?? colors.textMuted}
                                        variant="solid"
                                    />
                                ) : null}
                                {status ? <Badge label={status} color={colors.textMuted} variant="soft" /> : null}
                            </View>
                            <Text style={textStyles.meta}>Season averages</Text>
                        </View>
                    </View>

                    <View style={styles.statGrid}>
                        {statCells(avgFpts, stats).map(([label, value]) => (
                            <View key={label} style={styles.statCell}>
                                <Text style={[styles.statValue, label === 'FP' && styles.statValueStrong]}>{value}</Text>
                                <Text style={styles.statLabel}>{label}</Text>
                            </View>
                        ))}
                    </View>

                    <View style={styles.actions}>
                        {actions.map((action) => (
                            <Pressable
                                key={action.key}
                                onPress={action.onPress}
                                accessibilityRole="button"
                                accessibilityLabel={action.accessibilityLabel ?? action.label}
                                style={({ hovered, pressed }: PressableState) => [
                                    styles.action,
                                    hovered && styles.actionHover,
                                    pressed && styles.actionPressed,
                                ]}
                            >
                                <MaterialIcons
                                    name={action.icon}
                                    size={20}
                                    color={action.tone === 'danger' ? colors.dangerDark : colors.textSecondary}
                                />
                                <Text style={[styles.actionLabel, action.tone === 'danger' && styles.actionLabelDanger]}>
                                    {action.label}
                                </Text>
                                <MaterialIcons name="chevron-right" size={20} color={colors.textPlaceholder} />
                            </Pressable>
                        ))}
                    </View>
                </View>
            ) : null}
        </Sheet>
    )
}

const styles = StyleSheet.create({
    body: { gap: spacing.lg },
    identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    identityText: { flex: 1, minWidth: 0, gap: spacing.xs },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
    statGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        overflow: 'hidden',
    },
    statCell: {
        width: '20%',
        paddingVertical: spacing.sm,
        alignItems: 'center',
        gap: spacing.xxs,
        borderColor: colors.separator,
        borderRightWidth: 1,
        borderBottomWidth: 1,
    },
    statValue: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary, fontVariant: ['tabular-nums'] as const },
    statValueStrong: { color: colors.primaryDark },
    statLabel: { ...textStyles.tableHeader },
    actions: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        overflow: 'hidden',
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 48,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        backgroundColor: colors.bgCard,
    },
    actionHover: { backgroundColor: colors.bgSubtle },
    actionPressed: { backgroundColor: colors.bgMuted },
    actionLabel: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    actionLabelDanger: { color: colors.dangerDark },
})
