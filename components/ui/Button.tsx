import { ComponentProps, ReactNode } from 'react'
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, controlSize, elevation, fontFamily, fontWeight, motion, radii } from '@/constants/tokens'

type IconName = ComponentProps<typeof MaterialIcons>['name']
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

type Props = {
    title?: string
    children?: ReactNode
    onPress?: () => void
    variant?: ButtonVariant
    size?: ButtonSize
    icon?: IconName
    iconRight?: IconName
    loading?: boolean
    disabled?: boolean
    fullWidth?: boolean
    style?: StyleProp<ViewStyle>
    accessibilityLabel?: string
}

type PressableState = { hovered?: boolean; pressed?: boolean }

const SIZES: Record<ButtonSize, { height: number; padX: number; font: number; icon: number; gap: number }> = controlSize.button

function variantColors(variant: ButtonVariant) {
    switch (variant) {
        case 'primary':
            return { bg: colors.primary, bgHover: colors.primaryDark, fg: colors.textWhite, border: 'transparent' }
        case 'danger':
            return { bg: colors.danger, bgHover: colors.dangerDark, fg: colors.textWhite, border: 'transparent' }
        case 'secondary':
            return { bg: colors.bgMuted, bgHover: colors.bgCard, fg: colors.textPrimary, border: colors.borderLight }
        case 'outline':
            // primaryDark (maple600) clears WCAG AA on cream; primary (maple500) does not.
            return { bg: 'transparent', bgHover: colors.primaryLight, fg: colors.primaryDark, border: colors.primaryBorder }
        case 'ghost':
            return { bg: 'transparent', bgHover: colors.bgMuted, fg: colors.textSecondary, border: 'transparent' }
    }
}

/** The single button primitive — every CTA/action in the app composes from this. */
export function Button({
    title,
    children,
    onPress,
    variant = 'primary',
    size = 'md',
    icon,
    iconRight,
    loading = false,
    disabled = false,
    fullWidth = false,
    style,
    accessibilityLabel,
}: Props) {
    const s = SIZES[size]
    const c = variantColors(variant)
    const isDisabled = disabled || loading
    const raised = variant === 'primary' || variant === 'danger'

    return (
        <Pressable
            onPress={onPress}
            disabled={isDisabled}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? title}
            accessibilityState={{ disabled: isDisabled }}
            style={({ hovered, pressed }: PressableState) => [
                styles.base,
                {
                    minHeight: s.height,
                    paddingHorizontal: s.padX,
                    gap: s.gap,
                    backgroundColor: hovered && !isDisabled ? c.bgHover : c.bg,
                    borderColor: c.border,
                    borderWidth: variant === 'outline' || variant === 'secondary' ? 1 : 0,
                },
                fullWidth && styles.fullWidth,
                raised && !isDisabled && (elevation('brandGlow') as ViewStyle),
                pressed && !isDisabled && styles.pressed,
                isDisabled && styles.disabled,
                style,
            ]}
        >
            {icon ? <MaterialIcons name={icon} size={s.icon} color={c.fg} /> : null}
            {title ? (
                <Text style={[styles.label, { color: c.fg, fontSize: s.font }]} numberOfLines={1}>
                    {title}
                </Text>
            ) : (
                children
            )}
            {iconRight ? <MaterialIcons name={iconRight} size={s.icon} color={c.fg} /> : null}
        </Pressable>
    )
}

const styles = StyleSheet.create({
    base: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous',
    } as ViewStyle,
    fullWidth: { width: '100%' },
    label: {
        fontWeight: fontWeight.bold,
        fontFamily: fontFamily.displayMedium,
        letterSpacing: 0.1,
    },
    pressed: { opacity: motion.pressedOpacity },
    disabled: { opacity: 0.5 },
})
