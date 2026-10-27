import { StatCell } from '@/components/ui/StatCell'
import type { ReactNode } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, controlSize, radii, spacing, textStyles } from '@/constants/tokens'
import type { PlayerSeasonAverages } from '@/lib/players'

type Props = {
    averages: PlayerSeasonAverages | null
    seasonYear: number
    /** League fantasy points per game; shown first when the league scores this season. */
    avgFantasyPoints?: number | null
    showFantasy?: boolean
    loading?: boolean
    includesLive?: boolean
    columns: number
    seasonControl?: ReactNode
    actions?: ReactNode
}

/** Season averages as one stat strip, fantasy points first. */
export function StatsOverview({ averages, seasonYear, avgFantasyPoints = null, columns, seasonControl, loading = false, includesLive = false, actions, showFantasy = avgFantasyPoints != null }: Props) {
    const cells = [
        showFantasy ? { label: 'FP/G', value: (avgFantasyPoints ?? 0).toFixed(1), lead: true } : null,
        { label: 'GP', value: averages ? String(averages.gamesPlayed) : '—' },
        { label: 'MIN', value: (averages?.avgMinutesPlayed ?? 0).toFixed(1) },
        { label: 'PTS', value: averages ? averages.avgPoints.toFixed(1) : '—' },
        { label: 'REB', value: averages ? averages.avgRebounds.toFixed(1) : '—' },
        { label: 'AST', value: averages ? averages.avgAssists.toFixed(1) : '—' },
        { label: 'STL', value: averages ? averages.avgSteals.toFixed(1) : '—' },
        { label: 'BLK', value: averages ? averages.avgBlocks.toFixed(1) : '—' },
        { label: '3PM', value: averages ? averages.avgThreePointersMade.toFixed(1) : '—' },
        { label: 'TO', value: averages ? averages.avgTurnovers.toFixed(1) : '—' },
    ].filter((cell): cell is { label: string; value: string; lead?: boolean } => cell != null)
    const basis = `${100 / columns}%` as `${number}%`
    return (
        <View style={styles.section} aria-busy={loading}>
            <View style={styles.heading}>
                <View style={styles.headingCopy}>
                <Text style={textStyles.sectionLabel} role="heading" aria-level={2} numberOfLines={1}>{seasonControl ? 'Season averages' : `${seasonYear - 1}–${String(seasonYear).slice(2)} averages`}{includesLive ? ' · Live' : ''}</Text>
                </View>
                {actions}
                {seasonControl}
            </View>
            <View style={styles.grid}>
                {cells.map(({ label, value, lead }) => (
                    <View key={label} style={[styles.cell, { flexBasis: basis, maxWidth: basis }]} accessible accessibilityLabel={`${value} ${label === 'FP/G' ? 'fantasy points per game' : label}`}>
                        <StatCell variant="summary" value={value} highlight={lead} />
                        <Text style={[styles.cellLabel, lead && styles.cellLabelLead]}>{label}</Text>
                    </View>
                ))}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    section: { gap: spacing.sm },
    headingCopy: { flex: 1, minWidth: 0 },
    heading: { minHeight: controlSize.minTouch, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden',
        paddingVertical: spacing.xs,
    },
    cell: {
        alignItems: 'center',
        paddingVertical: spacing.sm,
        gap: spacing.xxs,
    },
    cellLabel: { ...textStyles.tableHeader },
    cellLabelLead: { color: colors.primaryDark },
})
