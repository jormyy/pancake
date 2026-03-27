import { Pressable, Text, ActivityIndicator, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, radii } from '@/constants/tokens'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

type Props = {
    title: string
    onPress: () => void
    variant?: Variant
    loading?: boolean
    disabled?: boolean
    /** Compact size for inline/row actions */
    small?: boolean
}

const BG: Record<Variant, string> = {
    primary: colors.primary,
    secondary: 'transparent',
    danger: 'transparent',
    ghost: 'transparent',
}

const FG: Record<Variant, string> = {
    primary: colors.textWhite,
    secondary: colors.textMuted,
    danger: colors.danger,
    ghost: colors.textMuted,
}

const BORDER: Record<Variant, string | undefined> = {
    primary: undefined,
    secondary: colors.border,
    danger: colors.danger,
    ghost: undefined,
}

const LOADER_COLOR: Record<Variant, string> = {
    primary: colors.textWhite,
    secondary: colors.textMuted,
    danger: colors.danger,
    ghost: colors.textMuted,
}

export function Button({
    title,
    onPress,
    variant = 'primary',
    loading = false,
    disabled = false,
    small = false,
}: Props) {
    const border = BORDER[variant]

    return (
        <Pressable
            style={[
                styles.base,
                small ? styles.small : styles.regular,
                { backgroundColor: BG[variant] },
                border ? { borderWidth: small ? 1 : 1.5, borderColor: border } : undefined,
                (disabled || loading) && styles.disabled,
            ]}
            onPress={onPress}
            disabled={disabled || loading}
        >
            {loading ? (
                <ActivityIndicator size="small" color={LOADER_COLOR[variant]} />
            ) : (
                <Text
                    style={[
                        styles.text,
                        small ? styles.textSmall : styles.textRegular,
                        { color: FG[variant] },
                    ]}
                >
                    {title}
                </Text>
            )}
        </Pressable>
    )
}

const styles = StyleSheet.create({
    base: {
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
    },
    regular: {
        height: 50,
        paddingHorizontal: 20,
    },
    small: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        minWidth: 60,
    },
    disabled: { opacity: 0.6 },
    text: { fontWeight: fontWeight.bold },
    textRegular: { fontSize: fontSize.lg },
    textSmall: { fontSize: fontSize.sm },
})
