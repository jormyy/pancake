import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, fontSize, fontWeight, motion, radii, spacing } from '@/constants/tokens'

type Props = {
    value: number
    onChange: (value: number) => void
    min?: number
    max?: number
    step?: number
    label?: string
}

type PressableState = { hovered?: boolean; pressed?: boolean }

/** ± numeric stepper (commissioner slot counts, budgets, etc.). */
export function Stepper({ value, onChange, min = 0, max = 99, step = 1, label }: Props) {
    const dec = () => onChange(Math.max(min, value - step))
    const inc = () => onChange(Math.min(max, value + step))
    const atMin = value <= min
    const atMax = value >= max

    return (
        <View style={styles.row}>
            <Pressable
                onPress={dec}
                disabled={atMin}
                accessibilityRole="button"
                accessibilityLabel={label ? `Decrease ${label}` : 'Decrease'}
                style={({ hovered, pressed }: PressableState) => [
                    styles.btn,
                    hovered && !atMin && styles.btnHover,
                    pressed && styles.pressed,
                    atMin && styles.btnDisabled,
                ]}
            >
                <MaterialIcons name="remove" size={18} color={atMin ? colors.textDisabled : colors.textPrimary} />
            </Pressable>
            <Text style={styles.value} accessibilityLabel={label ? `${label}: ${value}` : String(value)}>
                {value}
            </Text>
            <Pressable
                onPress={inc}
                disabled={atMax}
                accessibilityRole="button"
                accessibilityLabel={label ? `Increase ${label}` : 'Increase'}
                style={({ hovered, pressed }: PressableState) => [
                    styles.btn,
                    hovered && !atMax && styles.btnHover,
                    pressed && styles.pressed,
                    atMax && styles.btnDisabled,
                ]}
            >
                <MaterialIcons name="add" size={18} color={atMax ? colors.textDisabled : colors.textPrimary} />
            </Pressable>
        </View>
    )
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    btn: {
        width: 36,
        height: 36,
        borderRadius: radii.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    btnHover: { backgroundColor: colors.bgSubtle, borderColor: colors.border },
    btnDisabled: { opacity: 0.5 },
    pressed: { opacity: motion.pressedOpacity },
    value: {
        minWidth: 28,
        textAlign: 'center',
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        fontVariant: ['tabular-nums'],
    },
})
