import { StyleSheet, View } from 'react-native'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { spacing } from '@/constants/tokens'

export function AutoSetModal({
    visible,
    disabled,
    onClose,
    onToday,
    onWholeWeek,
    onRestOfSeason,
    onEditManually,
}: {
    visible: boolean
    disabled: boolean
    onClose: () => void
    onToday: () => void
    onWholeWeek: () => void
    onRestOfSeason: () => void
    onEditManually?: () => void
}) {
    return (
        <Sheet visible={visible} onClose={onClose} title="Auto-set lineup">
            <View style={styles.body}>
                <View style={styles.row}>
                    <Button title="Today" onPress={onToday} disabled={disabled} accessibilityLabel="Auto-set today" style={styles.flex} />
                    <Button title="This week" onPress={onWholeWeek} disabled={disabled} accessibilityLabel="Auto-set this week" style={styles.flex} />
                </View>
                <Button
                    title="Rest of season"
                    variant="secondary"
                    onPress={onRestOfSeason}
                    disabled={disabled}
                    accessibilityLabel="Auto-set rest of season"
                    fullWidth
                />
                {onEditManually ? (
                    <Button
                        title="Edit lineup manually"
                        variant="ghost"
                        onPress={onEditManually}
                        accessibilityLabel="Edit lineup manually"
                        fullWidth
                    />
                ) : null}
            </View>
        </Sheet>
    )
}

const styles = StyleSheet.create({
    body: { gap: spacing.md },
    row: { flexDirection: 'row', gap: spacing.md },
    flex: { flex: 1 },
})
