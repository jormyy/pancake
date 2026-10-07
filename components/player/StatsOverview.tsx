import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import type { PlayerSeasonAverages } from '@/lib/players'

function pct(made: number, attempted: number): string {
    if (!attempted) return '—'
    return ((made / attempted) * 100).toFixed(1) + '%'
}

function seasonLabel(year: number): string {
    return `${year - 1}–${String(year).slice(2)}`
}

function countLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`
}

type Props = {
    averages: PlayerSeasonAverages
    seasonYear: number
    /** League fantasy points per game; shown first when the league scores this season. */
    avgFantasyPoints?: number | null
    /** Cells per row: 4 in a side column or on phones, 6 in a wide single column. */
    columns: number
}

/** Season averages as one stat strip, fantasy points first. */
export function StatsOverview({ averages, seasonYear, avgFantasyPoints = null, columns }: Props) {
    const cells = [
        avgFantasyPoints != null ? { label: 'FP/G', value: avgFantasyPoints.toFixed(1), lead: true } : null,
        { label: 'MIN', value: averages.avgMinutesPlayed.toFixed(1) },
        { label: 'PTS', value: averages.avgPoints.toFixed(1) },
        { label: 'REB', value: averages.avgRebounds.toFixed(1) },
        { label: 'AST', value: averages.avgAssists.toFixed(1) },
        { label: 'STL', value: averages.avgSteals.toFixed(1) },
        { label: 'BLK', value: averages.avgBlocks.toFixed(1) },
        { label: '3PM', value: averages.avgThreePointersMade.toFixed(1) },
        { label: 'TO', value: averages.avgTurnovers.toFixed(1) },
        { label: 'FG%', value: pct(averages.avgFieldGoalsMade, averages.avgFieldGoalsAttempted) },
        { label: 'FT%', value: pct(averages.avgFreeThrowsMade, averages.avgFreeThrowsAttempted) },
        { label: 'GP', value: String(averages.gamesPlayed) },
    ].filter((cell): cell is { label: string; value: string; lead?: boolean } => cell != null)
    const basis = `${100 / columns}%` as `${number}%`
    const details = [
        `FG ${averages.avgFieldGoalsMade.toFixed(1)}-${averages.avgFieldGoalsAttempted.toFixed(1)}`,
        `FT ${averages.avgFreeThrowsMade.toFixed(1)}-${averages.avgFreeThrowsAttempted.toFixed(1)}`,
        countLabel(averages.doubleDoubles, 'double-double'),
        countLabel(averages.tripleDoubles, 'triple-double'),
    ].join(' · ')

    return (
        <View style={styles.section}>
            <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>{seasonLabel(seasonYear)} Averages</Text>
            <View style={styles.grid}>
                {cells.map(({ label, value, lead }) => (
                    <View key={label} style={[styles.cell, { flexBasis: basis, maxWidth: basis }]}>
                        <Text style={[styles.cellValue, lead && styles.cellValueLead]} numberOfLines={1}>{value}</Text>
                        <Text style={[styles.cellLabel, lead && styles.cellLabelLead]}>{label}</Text>
                    </View>
                ))}
            </View>
            <Text style={textStyles.meta}>{details}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    section: { gap: spacing.md },
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
    cellValue: { fontSize: fontSize['2lg'], fontWeight: fontWeight.bold, color: colors.textPrimary, fontVariant: ['tabular-nums'] as const },
    cellValueLead: { color: colors.primaryDark, fontWeight: fontWeight.extrabold },
    cellLabel: { ...textStyles.tableHeader },
    cellLabelLead: { color: colors.primaryDark },
})
