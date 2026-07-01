import { StyleSheet, Text, View } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import {
    compactProjectionStatLine,
    formatProjectionGame,
    numberOrDash,
    projectionFreshnessLabel,
    type LeagueProjectionRow,
} from '@/lib/projections'

export function NextProjectionCard({ projection }: { projection: LeagueProjectionRow }) {
    const statLine = compactProjectionStatLine(projection)
    const game = formatProjectionGame(projection)
    const freshness = projectionFreshnessLabel(projection.projection_fetched_at)

    return (
        <View style={styles.card}>
            <View style={styles.topRow}>
                <View>
                    <Text style={styles.label}>Next Projection</Text>
                    <Text style={styles.meta} numberOfLines={1}>
                        {[game, projection.projection_status, projection.projection_source_label, freshness].filter(Boolean).join(' · ')}
                    </Text>
                </View>
                <View style={styles.scoreBox}>
                    <Text style={styles.score}>{numberOrDash(projection.projection_fantasy_points)}</Text>
                    <Text style={styles.scoreLabel}>FP</Text>
                </View>
            </View>
            <View style={styles.detailRow}>
                {projection.projection_minutes != null ? (
                    <View style={styles.metric}>
                        <Text style={styles.metricValue}>{numberOrDash(projection.projection_minutes)}</Text>
                        <Text style={styles.metricLabel}>MIN</Text>
                    </View>
                ) : null}
                {statLine ? <Text style={styles.statLine} numberOfLines={2}>{statLine}</Text> : null}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        borderCurve: 'continuous',
        padding: spacing.xl,
        gap: spacing.lg,
    },
    topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.lg },
    label: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    meta: { marginTop: spacing.xs, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textMuted },
    scoreBox: { alignItems: 'flex-end', minWidth: 72 },
    score: {
        fontSize: fontSize['2xl'],
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        fontVariant: ['tabular-nums'],
    },
    scoreLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, flexWrap: 'wrap' },
    metric: {
        minWidth: 52,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radii.sm,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgSubtle,
        alignItems: 'center',
    },
    metricValue: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    metricLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted },
    statLine: { flex: 1, minWidth: 180, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
