import { StyleSheet, Switch, Text, View } from 'react-native'
import { controlSize, spacing, textStyles } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'

/** Header switch for keeping the lineup updated automatically. */
export function AutoSetToggle({ enabled, disabled, onChange }: { enabled: boolean; disabled?: boolean; onChange: (enabled: boolean) => void }) {
    return (
        <MotionPressable style={styles.toggle} onPress={() => onChange(!enabled)} disabled={disabled}
            accessibilityRole="switch" aria-checked={enabled} accessibilityLabel="Auto-set lineup"
            accessibilityState={{ checked: enabled, disabled }}>
            <Text style={styles.label}>Auto-set</Text>
            <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Switch value={enabled} onValueChange={onChange} disabled={disabled} />
            </View>
        </MotionPressable>
    )
}

const styles = StyleSheet.create({
    toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: controlSize.minTouch },
    label: textStyles.body,
})
