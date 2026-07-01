import type { ReactNode } from 'react'
import {
    Pressable,
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import {
    compactProjectionStatLine,
    formatProjectionGame,
    numberOrDash,
    projectionFreshnessLabel,
    projectionViewLabel,
    type LeagueProjectionRow,
} from '@/lib/projections'

type Props = {
    projection: LeagueProjectionRow
    title?: string
    header?: ReactNode
    footer?: ReactNode
    compact?: boolean
    onPress?: () => void
    accessibilityLabel?: string
    style?: StyleProp<ViewStyle>
}

export function ProjectionCard({
    projection,
    title = 'Projection',
    header,
    footer,
    compact = false,
    onPress,
    accessibilityLabel,
    style,
}: Props) {
    const statLine = compactProjectionStatLine(projection)
    const game = formatProjectionGame(projection)
    const freshness = projectionFreshnessLabel(projection.projection_fetched_at)
    const view = projectionViewLabel(projection.projection_view)
    const meta = [
        game,
        projection.projection_status,
        projection.projection_source_label,
        view,
        freshness,
    ].filter(Boolean).join(' · ')

    const content = (
        <>
            {header ? <View style={styles.headerSlot}>{header}</View> : null}
            <View style={[styles.topRow, compact && styles.topRowCompact]}>
                <View style={styles.copy}>
                    <Text style={styles.label}>{title}</Text>
                    <Text style={styles.meta} numberOfLines={compact ? 2 : 1}>{meta}</Text>
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
                {statLine ? <Text style={styles.statLine} numberOfLines={compact ? 3 : 2}>{statLine}</Text> : null}
            </View>
            {footer ? <View style={styles.footerSlot}>{footer}</View> : null}
        </>
    )

    if (onPress) {
        return (
            <Pressable
                style={[styles.card, compact && styles.cardCompact, style]}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
            >
                {content}
            </Pressable>
        )
    }

    return <View style={[styles.card, compact && styles.cardCompact, style]}>{content}</View>
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
    cardCompact: { padding: spacing.lg },
    headerSlot: { minWidth: 0 },
    topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.lg },
    topRowCompact: { alignItems: 'flex-start' },
    copy: { flex: 1, minWidth: 0 },
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
    footerSlot: { minWidth: 0 },
})
