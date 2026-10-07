import type { ReactNode } from 'react'
import {
    Pressable,
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
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
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        padding: spacing.lg,
        gap: spacing.sm,
    },
    cardCompact: { padding: spacing.lg },
    headerSlot: { minWidth: 0 },
    topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.lg },
    topRowCompact: { alignItems: 'flex-start' },
    copy: { flex: 1, minWidth: 0 },
    label: { ...textStyles.sectionLabel },
    meta: { ...textStyles.meta, marginTop: spacing.xs },
    scoreBox: { alignItems: 'flex-end', minWidth: 72 },
    score: {
        fontSize: fontSize['2xl'],
        fontWeight: fontWeight.extrabold,
        color: colors.primaryDark,
        fontVariant: ['tabular-nums'],
    },
    scoreLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, flexWrap: 'wrap' },
    statLine: { ...textStyles.stat, flex: 1, minWidth: 180, fontWeight: fontWeight.semibold },
    footerSlot: { minWidth: 0 },
})
