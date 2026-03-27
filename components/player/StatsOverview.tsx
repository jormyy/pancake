import { View, Text, StyleSheet } from 'react-native'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import type { PlayerSeasonAverages } from '@/lib/players'

function pct(made: number, attempted: number): string {
    if (!attempted) return '—'
    return ((made / attempted) * 100).toFixed(1) + '%'
}

function seasonLabel(year: number): string {
    return `${year - 1}–${String(year).slice(2)}`
}

type Props = {
    averages: PlayerSeasonAverages
    seasonYear: number
}

export function StatsOverview({ averages, seasonYear }: Props) {
    return (
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>{seasonLabel(seasonYear)} Averages</Text>

            {/* Primary stats */}
            <View style={styles.grid}>
                {[
                    { label: 'PTS', value: averages.avgPoints.toFixed(1) },
                    { label: 'REB', value: averages.avgRebounds.toFixed(1) },
                    { label: 'AST', value: averages.avgAssists.toFixed(1) },
                    { label: 'STL', value: averages.avgSteals.toFixed(1) },
                    { label: 'BLK', value: averages.avgBlocks.toFixed(1) },
                    { label: '3PM', value: averages.avgThreePointersMade.toFixed(1) },
                    { label: 'TO', value: averages.avgTurnovers.toFixed(1) },
                    { label: 'MIN', value: averages.avgMinutesPlayed.toFixed(1) },
                ].map(({ label, value }) => (
                    <View key={label} style={styles.cell}>
                        <Text style={styles.cellValue}>{value}</Text>
                        <Text style={styles.cellLabel}>{label}</Text>
                    </View>
                ))}
            </View>

            {/* Shooting splits */}
            <Text style={styles.subTitle}>Shooting</Text>
            <View style={styles.grid}>
                {[
                    {
                        label: 'FG%',
                        value: pct(averages.avgFieldGoalsMade, averages.avgFieldGoalsAttempted),
                    },
                    {
                        label: 'FT%',
                        value: pct(averages.avgFreeThrowsMade, averages.avgFreeThrowsAttempted),
                    },
                    {
                        label: 'FGM-A',
                        value: `${averages.avgFieldGoalsMade.toFixed(1)}-${averages.avgFieldGoalsAttempted.toFixed(1)}`,
                    },
                    {
                        label: 'FTM-A',
                        value: `${averages.avgFreeThrowsMade.toFixed(1)}-${averages.avgFreeThrowsAttempted.toFixed(1)}`,
                    },
                ].map(({ label, value }) => (
                    <View key={label} style={styles.cell}>
                        <Text style={styles.cellValue}>{value}</Text>
                        <Text style={styles.cellLabel}>{label}</Text>
                    </View>
                ))}
            </View>

            {/* Extras row */}
            <View style={styles.extrasRow}>
                {[
                    { label: 'GP', value: String(averages.gamesPlayed) },
                    { label: 'DD', value: String(averages.doubleDoubles) },
                    { label: 'TD', value: String(averages.tripleDoubles) },
                    { label: 'FTA', value: averages.avgFreeThrowsAttempted.toFixed(1) },
                ].map(({ label, value }) => (
                    <View key={label} style={styles.extraCell}>
                        <Text style={styles.extraValue}>{value}</Text>
                        <Text style={styles.cellLabel}>{label}</Text>
                    </View>
                ))}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    section: { gap: 10 },
    sectionTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    subTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted, marginTop: 2 },

    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        backgroundColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        overflow: 'hidden',
    },
    cell: {
        flex: 1,
        minWidth: '22%',
        backgroundColor: colors.bgScreen,
        alignItems: 'center',
        paddingVertical: radii.xl,
        gap: spacing.xs,
    },
    cellValue: { fontSize: 18, fontWeight: fontWeight.bold, color: colors.textPrimary },
    cellLabel: { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: fontWeight.semibold },

    extrasRow: {
        flexDirection: 'row',
        gap: 1,
        backgroundColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        overflow: 'hidden',
    },
    extraCell: {
        flex: 1,
        backgroundColor: palette.gray50,
        alignItems: 'center',
        paddingVertical: 10,
        gap: spacing.xs,
    },
    extraValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: palette.gray900 },
})
