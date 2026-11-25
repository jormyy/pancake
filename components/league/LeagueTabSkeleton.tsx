import { View, StyleSheet } from 'react-native'
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'
import { colors, layout, radii, spacing, table } from '@/constants/tokens'

const ROW_COUNT = 4

export function LeagueTabSkeleton({ label }: { label: string }) {
    return (
        <View style={styles.content}>
            <Card padding="none" elevated="none" style={styles.card}>
                <SectionBand label={label} />
                {Array.from({ length: ROW_COUNT }, (_, index) => (
                    <View key={index} style={[styles.row, index < ROW_COUNT - 1 && styles.divider]}
                        aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <View style={styles.bar} />
                    </View>
                ))}
            </Card>
        </View>
    )
}

const styles = StyleSheet.create({
    content: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md },
    card: { width: '100%', maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular, alignSelf: 'center', overflow: 'hidden' },
    row: { minHeight: table.rowHeightCompact, justifyContent: 'center', paddingHorizontal: spacing.lg },
    divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
    bar: { height: spacing.md, width: '58%', borderRadius: radii.sm, backgroundColor: colors.bgSubtle },
})
