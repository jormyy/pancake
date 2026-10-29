import { StyleSheet, Switch, Text, View } from 'react-native'
import { componentTokens, controlSize, textStyles } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'

type Props = {
    automatic: boolean
    automaticDisabled?: boolean
    onAutomaticChange: (enabled: boolean) => void
}

export function LineupControls({ automatic, automaticDisabled, onAutomaticChange }: Props) {
    return <>
        <MotionPressable style={styles.preference} onPress={() => onAutomaticChange(!automatic)} disabled={automaticDisabled}
            accessibilityRole="switch" aria-checked={automatic} accessibilityLabel="Keep lineup updated automatically"
            accessibilityState={{ checked: automatic, disabled: automaticDisabled }}>
            <Text style={styles.preferenceLabel}>Keep updated automatically</Text>
            <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Switch value={automatic} onValueChange={onAutomaticChange} disabled={automaticDisabled} />
            </View>
        </MotionPressable>
    </>
}

const styles = StyleSheet.create({
    preference: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: componentTokens.lineupControls.gap, minHeight: controlSize.minTouch },
    preferenceLabel: { ...textStyles.body, flex: 1 },
})
