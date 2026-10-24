import type { ReactNode } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
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
        showFantasy ? { label: 'FP/G', value: loading || avgFantasyPoints == null ? '—' : avgFantasyPoints.toFixed(1), lead: true } : null,
        { label: 'GP', value: averages ? String(averages.gamesPlayed) : '—' },
        { label: 'MIN', value: averages ? averages.avgMinutesPlayed.toFixed(1) : '—' },
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
                <Text style={textStyles.sectionLabel} role="heading" aria-level={2}>{seasonControl ? 'Season averages' : `${seasonYear - 1}–${String(seasonYear).slice(2)} averages`}</Text>
                <Text style={styles.liveNote}>{includesLive ? 'Includes live game' : loading ? 'Loading season stats…' : averages ? ' ' : 'No stats available.'}</Text>
                </View>
                {actions}
                {seasonControl}
            </View>
            <View style={styles.grid}>
                {cells.map(({ label, value, lead }) => (
                    <View key={label} style={[styles.cell, { flexBasis: basis, maxWidth: basis }]} accessible accessibilityLabel={`${value} ${label === 'FP/G' ? 'fantasy points per game' : label}`}>
                        <Text style={[styles.cellValue, lead && styles.cellValueLead]} numberOfLines={1}>{value}</Text>
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
    liveNote: { ...textStyles.meta, height: 18 },
    heading: { minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
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
