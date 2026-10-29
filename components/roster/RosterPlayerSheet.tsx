import { LockedAssetNotice } from '@/components/roster/LockedAssetNotice'
import { readAssetLocks } from '@/lib/locked-assets'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { ComponentProps } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'



import { Sheet } from '@/components/ui/Sheet'
import { colors, controlSize, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { formatPoints } from '@/lib/format'
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
    disabled?: boolean
    accessibilityLabel?: string
}

function statCells(avgFpts: number | undefined, stats: RosterAverage | undefined): [string, string][] {
    const fmt = (value: number | null | undefined) => (value == null ? '—' : formatPoints(value))
    return [
        ['FP', fmt(avgFpts ?? 0)],
        ['MIN', fmt(stats?.avg_minutes_played ?? 0)],
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
    const locks = readAssetLocks(player)
    const info = player?.players
    const positions = info ? getEligiblePositions(info) : []
    const status = player?.is_on_ir ? 'On IR' : player?.is_on_taxi ? 'Taxi squad' : null

    return (
        <Sheet visible={player != null} onClose={onClose} title={info?.display_name ?? 'Player'}>
            {info ? (
                <View style={styles.body}>
                    <View style={styles.identity}>
                        <PlayerRowContent name={info.display_name} nbaId={info.nba_id} team={info.nba_team} positions={positions}
                            birthdate={info.birthdate} yearsExp={info.years_exp} careerGames={info.career_regular_season_games} injuryStatus={info.injury_status} onTaxi={player?.is_on_taxi}
                            stats={`${formatPoints(avgFpts ?? 0)} FP · ${formatPoints(stats?.avg_minutes_played ?? 0)} mins${status ? ` · ${status}` : ''}`} />
                    </View>

                    <View style={styles.statGrid}>
                        {statCells(avgFpts, stats).map(([label, value]) => (
                            <View key={label} style={styles.statCell}>
                                <Text style={[styles.statValue, label === 'FP' && styles.statValueStrong]}>{value}</Text>
                                <Text style={styles.statLabel}>{label}</Text>
                            </View>
                        ))}
                    </View>

                    <LockedAssetNotice locks={locks} onNavigate={onClose} />
                    <View style={styles.actions}>
                        {actions.map((action, index) => (
                            <Pressable
                                key={action.key}
                                onPress={action.onPress}
                                disabled={action.disabled || locks.length > 0 && action.key !== 'page'}
                                accessibilityState={{ disabled: action.disabled || locks.length > 0 && action.key !== 'page' }}
                                accessibilityRole="button"
                                accessibilityLabel={action.accessibilityLabel ?? action.label}
                                style={({ hovered, pressed }: PressableState) => [
                                    styles.action,
                                    (action.disabled || locks.length > 0 && action.key !== 'page') && { opacity: 0.5 },
                                    index < actions.length - 1 && styles.actionDivider,
                                    hovered && styles.actionHover,
                                    pressed && styles.actionPressed,
                                ]}
                            >
                                <MaterialIcons
                                    name={action.icon}
                                    size={controlSize.icon.md}
                                    color={action.tone === 'danger' ? colors.dangerDark : colors.textSecondary}
                                />
                                <Text style={[styles.actionLabel, action.tone === 'danger' && styles.actionLabelDanger]}>
                                    {action.label}
                                </Text>
                                <MaterialIcons name="chevron-right" size={controlSize.icon.md} color={colors.textPlaceholder} />
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
        minHeight: controlSize.button.md.height,
        paddingHorizontal: spacing.lg,
        backgroundColor: colors.bgCard,
    },
    actionDivider: { borderBottomWidth: 1, borderBottomColor: colors.separator },
    actionHover: { backgroundColor: colors.bgSubtle },
    actionPressed: { backgroundColor: colors.bgMuted },
    actionLabel: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    actionLabelDanger: { color: colors.dangerDark },
})
