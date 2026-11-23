import { LockedActionExplanation } from '@/components/roster/LockedAssetNotice'
import { rosterActionDisabledStyle } from '@/components/roster/RosterItems'
import type { AssetLock } from '@/lib/locked-assets'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { ComponentProps } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Sheet } from '@/components/ui/Sheet'
import { colors, controlSize, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { formatAvgPoints, formatStat } from '@/lib/format'
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
    const fmt = (value: number | null | undefined) => (value == null ? '—' : formatStat(value))
    return [
        ['FP', formatAvgPoints(avgFpts ?? 0)],
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

export type PlayerPreview = {
    name: string
    nbaId?: string | null
    team?: string | null
    positions: readonly string[]
    birthdate?: string | null
    yearsExp?: number | null
    careerGames?: number | null
    injuryStatus?: string | null
    onTaxi?: boolean
    /** Appended to the averages line, e.g. "On IR". */
    status?: string | null
    locks?: readonly AssetLock[]
}

/**
 * A player at a glance, one tap from a list: season averages up top, then each
 * action that applies. Actions other than the player page respect asset locks.
 */
export function PlayerPreviewSheet({
    player,
    avgFpts,
    stats,
    actions,
    onClose,
}: {
    player: PlayerPreview | null
    avgFpts?: number
    stats?: RosterAverage
    actions: RosterSheetAction[]
    onClose: () => void
}) {
    const locks = player?.locks ?? []
    const status = player?.status ?? null

    return (
        <Sheet visible={player != null} onClose={onClose} title={player?.name ?? 'Player'}>
            {player ? (
                <View style={styles.body}>
                    <View style={styles.identity}>
                        <PlayerRowContent locks={locks} name={player.name} nbaId={player.nbaId} team={player.team} positions={player.positions}
                            birthdate={player.birthdate} yearsExp={player.yearsExp} careerGames={player.careerGames} injuryStatus={player.injuryStatus} onTaxi={player.onTaxi}
                            stats={`${formatAvgPoints(avgFpts ?? 0)} FP · ${formatStat(stats?.avg_minutes_played ?? 0)} mins${status ? ` · ${status}` : ''}`} />
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
                        {actions.map((action, index) => (
                            <LockedActionExplanation key={action.key} locks={action.key === 'page' ? [] : locks} label={action.label}>
                            <Pressable
                                onPress={action.onPress}
                                disabled={action.disabled || locks.length > 0 && action.key !== 'page'}
                                accessibilityState={{ disabled: action.disabled || locks.length > 0 && action.key !== 'page' }}
                                accessibilityRole="button"
                                accessibilityLabel={action.accessibilityLabel ?? action.label}
                                style={({ hovered, pressed }: PressableState) => [
                                    styles.action,
                                    (action.disabled || locks.length > 0 && action.key !== 'page') && rosterActionDisabledStyle,
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
                            </Pressable></LockedActionExplanation>
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
