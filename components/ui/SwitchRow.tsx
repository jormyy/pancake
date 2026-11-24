import type { ReactNode } from 'react'
import { StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native'
import { controlSize, spacing } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'

type Props = {
    accessibilityLabel: string
    value: boolean
    onValueChange: (value: boolean) => void
    disabled?: boolean
    children: ReactNode
    style?: StyleProp<ViewStyle>
}

export function SwitchRow({ accessibilityLabel, value, onValueChange, disabled = false, children, style }: Props) {
    return (
        <MotionPressable style={[styles.row, style]} onPress={() => onValueChange(!value)} disabled={disabled}
            accessibilityRole="switch" aria-checked={value} accessibilityLabel={accessibilityLabel}
            accessibilityState={{ checked: value, disabled }}>
            {children}
            <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
            </View>
        </MotionPressable>
    )
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: controlSize.minTouch },
})
