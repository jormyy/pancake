import { StyleSheet, Text, View } from 'react-native'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui'
import { SectionBand } from '@/components/ui/SectionBand'
import { borderWidth, colors, controlSize, fontFamily, fontWeight, radii, spacing, textStyles, typeScale } from '@/constants/tokens'

export function TradeNeedsCard({
    incoming,
    awaitingVote,
    outgoing,
    proposeDisabled,
    onPropose,
}: {
    incoming: number
    awaitingVote: number
    outgoing: number
    proposeDisabled: boolean
    onPropose: () => void
}) {
    const total = incoming + awaitingVote + outgoing
    const rows = [
        { key: 'incoming', count: incoming, label: incoming === 1 ? 'offer to answer' : 'offers to answer' },
        { key: 'vote', count: awaitingVote, label: awaitingVote === 1 ? 'trade awaiting your vote' : 'trades awaiting your vote' },
        { key: 'outgoing', count: outgoing, label: outgoing === 1 ? 'pending offer' : 'pending offers' },
    ].filter((row) => row.count > 0)

    return (
        <View style={styles.card}>
            <SectionBand
                label="Needs you now"
                detail={total > 0
                    ? <Badge size="count" variant="solid" label={total} color={colors.primary} textColor={colors.textWhite} />
                    : <Text style={styles.clear}>All clear</Text>}
            />
            {rows.length > 0 ? rows.map((row, index) => (
                <View key={row.key} style={[styles.row, index > 0 && styles.rowDivider]}
                    accessible accessibilityLabel={`${row.count} ${row.label}`}>
                    <Text style={styles.count}>{row.count}</Text>
                    <Text style={styles.rowLabel}>{row.label}</Text>
                </View>
            )) : (
                <View style={styles.empty}>
                    <Text style={styles.emptyTitle}>All caught up</Text>
                    <Text style={styles.emptyCopy}>No offers are waiting on you. Start one any time.</Text>
                    <Button
                        title="Propose trade"
                        icon="swap-horiz"
                        size="lg"
                        fullWidth
                        onPress={onPropose}
                        disabled={proposeDisabled}
                        accessibilityLabel="Propose trade"
                    />
                </View>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    card: {
        backgroundColor: colors.bgCard,
        borderWidth: borderWidth.thin,
        borderColor: colors.borderLight,
        borderRadius: radii.xl,
        borderCurve: 'continuous',
        overflow: 'hidden',
        marginBottom: spacing.md,
    },
    clear: { ...textStyles.meta, color: colors.textSecondary },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    rowDivider: { borderTopWidth: borderWidth.thin, borderTopColor: colors.separator },
    count: {
        ...typeScale.title,
        minWidth: spacing['3xl'],
        color: colors.primaryDark,
        fontWeight: fontWeight.black,
        fontVariant: ['tabular-nums'] as const,
    },
    rowLabel: { ...textStyles.body, flexShrink: 1, color: colors.textPrimary },
    empty: { alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.xl },
    emptyTitle: {
        ...typeScale.row,
        color: colors.textSecondary,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
        textAlign: 'center',
    },
    emptyCopy: { ...typeScale.body, color: colors.textMuted, textAlign: 'center' },
})
