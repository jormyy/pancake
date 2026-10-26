import { ComponentProps, ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type AccessibilityState, type StyleProp, type ViewStyle, type TextStyle } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, controlSize, elevation, fontFamily, fontWeight, motion, radii } from '@/constants/tokens'

type IconName = ComponentProps<typeof MaterialIcons>['name']
type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost'
type ButtonSize = 'inline' | 'sm' | 'md' | 'lg'

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
    labelStyle?: StyleProp<TextStyle>
    accessibilityLabel?: string
    accessibilityHint?: string
    accessibilityState?: AccessibilityState
}

type PressableState = { hovered?: boolean; pressed?: boolean }

const SIZES: Record<ButtonSize, { height: number; padX: number; font: number; icon: number; gap: number }> = controlSize.button

function variantColors(variant: ButtonVariant) {
    switch (variant) {
        case 'primary':
            return { bg: colors.primary, bgHover: colors.primaryHover, fg: colors.textWhite, border: 'transparent' }
        case 'danger':
            return { bg: colors.danger, bgHover: colors.dangerDark, fg: colors.onAccent, border: 'transparent' }
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
    labelStyle,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
}: Props) {
    const s = SIZES[size]
    const c = variantColors(variant)
    const isDisabled = disabled || loading
    const raised = variant === 'primary' || variant === 'danger'

    const inline = size === 'inline'
    const surfaceStyle = ({ hovered, pressed }: PressableState) => [
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
        raised && !inline && !isDisabled && (elevation('sm') as ViewStyle),
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
    ]
    const content = <>
        {icon ? <MaterialIcons name={icon} size={s.icon} color={c.fg} /> : null}
        {title ? (
            <Text style={[styles.label, { color: c.fg, fontSize: s.font }, inline && styles.inlineLabel, labelStyle]} numberOfLines={1}>
                {title}
            </Text>
        ) : children}
        {iconRight ? <MaterialIcons name={iconRight} size={s.icon} color={c.fg} /> : null}
    </>

    return (
        <Pressable
            onPress={onPress}
            disabled={isDisabled}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? title}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ ...accessibilityState, disabled: isDisabled || accessibilityState?.disabled === true }}
            style={state => [inline ? [styles.inlineTarget, state.pressed && !isDisabled && styles.pressed] : surfaceStyle(state), fullWidth && styles.fullWidth, style]}
        >
            {inline ? <View pointerEvents="none" style={surfaceStyle({})}>{content}</View> : content}
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
    inlineTarget: { minHeight: controlSize.minTouch, minWidth: controlSize.minTouch, alignItems: 'center', justifyContent: 'center' },
    inlineLabel: { lineHeight: controlSize.icon.sm, fontWeight: fontWeight.semibold, fontFamily: fontFamily.control, letterSpacing: 0 },
    label: {
        fontWeight: fontWeight.bold,
        fontFamily: fontFamily.displayMedium,
        letterSpacing: 0.1,
    },
    pressed: { opacity: motion.pressedOpacity },
    disabled: { opacity: 0.5 },
})
