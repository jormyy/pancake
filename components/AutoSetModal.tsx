import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { StyleSheet, Text, View } from 'react-native'
import { colors, controlSize, radii, spacing, textStyles } from '@/constants/tokens'

export function AutoSetModal({
    visible,
    onClose,
    onEditManually,
}: {
    visible: boolean
    onClose: () => void
    onEditManually: () => void
}) {
    return (
        <Sheet visible={visible} onClose={onClose} title="Auto-set lineup">
            <View style={styles.intro}>
                <View style={styles.icon}>
                    <MaterialIcons name="flash-on" size={controlSize.icon.lg} color={colors.primaryDark} />
                </View>
                <View style={styles.copy}>
                    <Text style={textStyles.rowTitle}>Your lineup, ready for game day</Text>
                    <Text style={textStyles.body}>Set daily automation or choose who starts and who stays on the bench.</Text>
                </View>
            </View>
            <Button
                title="Edit lineup manually"
                icon="edit"
                onPress={onEditManually}
                accessibilityLabel="Edit lineup manually"
                fullWidth
            />
        </Sheet>
    )
}

const styles = StyleSheet.create({
    intro: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center', marginBottom: spacing.xl },
    icon: { width: controlSize.minTouch, height: controlSize.minTouch, backgroundColor: colors.primaryLight, borderRadius: radii.xl, alignItems: 'center', justifyContent: 'center' },
    copy: { flex: 1, minWidth: 0, gap: spacing.xs },
})
