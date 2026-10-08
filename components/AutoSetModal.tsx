import { StyleSheet, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { spacing } from '@/constants/tokens'

export function AutoSetModal({
    visible,
    onClose,
    onToday,
    onWholeWeek,
    onRestOfSeason,
    seasonOptimizerEnabled = false,
    onEnableSeasonOptimizer,
    onDisableSeasonOptimizer,
    onEditManually,
}: {
    visible: boolean
    onClose: () => void
    onToday: () => void
    onWholeWeek: () => void
    onRestOfSeason: () => void
    seasonOptimizerEnabled?: boolean
    onEnableSeasonOptimizer?: () => void
    onDisableSeasonOptimizer?: () => void
    onEditManually?: () => void
}) {
    return (
        <Sheet visible={visible} onClose={onClose} title="Auto-set lineup">
            <View style={styles.body}>
                <View style={styles.row}>
                    <Button title="Today" onPress={onToday} accessibilityLabel="Auto-set today" style={styles.flex} />
                    <Button title="Whole week" onPress={onWholeWeek} accessibilityLabel="Auto-set whole week" style={styles.flex} />
                </View>
                <Button
                    title="Rest of season"
                    variant="secondary"
                    onPress={onRestOfSeason}
                    accessibilityLabel="Auto-set rest of season"
                    fullWidth
                />
                {onEnableSeasonOptimizer && onDisableSeasonOptimizer ? (
                    <Button
                        title={seasonOptimizerEnabled ? 'Turn off season optimizer' : 'Turn on season optimizer'}
                        variant="outline"
                        onPress={seasonOptimizerEnabled ? onDisableSeasonOptimizer : onEnableSeasonOptimizer}
                        accessibilityLabel={seasonOptimizerEnabled ? 'Disable season optimizer' : 'Enable season optimizer'}
                        fullWidth
                    />
                ) : null}
                {onEditManually ? (
                    <Button
                        title="Edit manually instead"
                        variant="ghost"
                        onPress={onEditManually}
                        accessibilityLabel="Edit lineup manually"
                        fullWidth
                    />
                ) : null}
                <Button title="Cancel" variant="ghost" onPress={onClose} accessibilityLabel="Cancel auto-set" fullWidth />
            </View>
        </Sheet>
    )
}

const styles = StyleSheet.create({
    body: { gap: spacing.md },
    row: { flexDirection: 'row', gap: spacing.md },
    flex: { flex: 1 },
})
