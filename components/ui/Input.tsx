import { ComponentProps, forwardRef } from 'react'
import { StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, fontFamily, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

type IconName = ComponentProps<typeof MaterialIcons>['name']

type Props = ComponentProps<typeof TextInput> & {
    label?: string
    error?: string | null
    hint?: string
    leftIcon?: IconName
    containerStyle?: StyleProp<ViewStyle>
}

/**
 * The single text-input primitive. Renders a programmatic label (associated for
 * screen readers), ≥16px font (no iOS focus-zoom), and inline error/hint.
 */
export const Input = forwardRef<TextInput, Props>(function Input(
    { label, error, hint, leftIcon, containerStyle, style, ...rest },
    ref,
) {
    return (
        <View style={[styles.container, containerStyle]}>
            {label ? (
                <Text style={styles.label} nativeID={rest.nativeID ? `${rest.nativeID}-label` : undefined}>
                    {label}
                </Text>
            ) : null}
            <View style={[styles.field, error ? styles.fieldError : null]}>
                {leftIcon ? (
                    <MaterialIcons name={leftIcon} size={18} color={colors.textMuted} style={styles.leftIcon} />
                ) : null}
                <TextInput
                    ref={ref}
                    placeholderTextColor={colors.textPlaceholder}
                    accessibilityLabel={rest.accessibilityLabel ?? label}
                    style={[styles.input, leftIcon ? styles.inputWithIcon : null, style]}
                    {...rest}
                />
            </View>
            {error ? (
                <Text style={styles.error} accessibilityLiveRegion="polite">
                    {error}
                </Text>
            ) : hint ? (
                <Text style={styles.hint}>{hint}</Text>
            ) : null}
        </View>
    )
})

const styles = StyleSheet.create({
    container: { gap: spacing.sm },
    label: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: colors.textMuted,
    },
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 50,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        backgroundColor: colors.bgCard,
        paddingHorizontal: spacing.lg,
    },
    fieldError: { borderColor: colors.danger },
    leftIcon: { marginRight: spacing.md },
    input: {
        flex: 1,
        fontSize: 16,
        fontFamily: fontFamily.body,
        color: colors.textPrimary,
        paddingVertical: spacing.lg,
    },
    inputWithIcon: { paddingLeft: 0 },
    error: {
        fontSize: fontSize.sm,
        color: colors.danger,
        fontWeight: fontWeight.medium,
    },
    hint: {
        fontSize: fontSize.sm,
        color: colors.textMuted,
    },
})
