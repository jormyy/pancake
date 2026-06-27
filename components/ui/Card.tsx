import { ReactNode } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, elevation, motion, radii, spacing, type ElevationLevel } from '@/constants/tokens'

type CardSurface = 'card' | 'screen' | 'muted' | 'subtle'

type Props = {
    children: ReactNode
    surface?: CardSurface
    elevated?: ElevationLevel
    bordered?: boolean
    padding?: keyof typeof spacing | number
    radius?: keyof typeof radii
    onPress?: () => void
    style?: StyleProp<ViewStyle>
    accessibilityLabel?: string
}

const SURFACE_BG: Record<CardSurface, string> = {
    card: colors.bgCard,
    screen: colors.bgScreen,
    muted: colors.bgMuted,
    subtle: colors.bgSubtle,
}

type PressableState = { hovered?: boolean; pressed?: boolean }

/** The single card/surface primitive — bg + border + radius + elevation by role. */
export function Card({
    children,
    surface = 'card',
    elevated = 'sm',
    bordered = true,
    padding = 'xl',
    radius = '2xl',
    onPress,
    style,
    accessibilityLabel,
}: Props) {
    const pad = typeof padding === 'number' ? padding : spacing[padding]
    const base: StyleProp<ViewStyle> = [
        styles.base,
        {
            backgroundColor: SURFACE_BG[surface],
            borderWidth: bordered ? 1 : 0,
            borderRadius: radii[radius],
            padding: pad,
        },
        elevated !== 'none' && (elevation(elevated) as ViewStyle),
        style,
    ]

    if (onPress) {
        return (
            <Pressable
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                style={({ hovered, pressed }: PressableState) => [
                    base,
                    hovered && styles.hover,
                    pressed && styles.pressed,
                ]}
            >
                {children}
            </Pressable>
        )
    }

    return <View style={base}>{children}</View>
}

const styles = StyleSheet.create({
    base: {
        borderColor: colors.borderLight,
        borderCurve: 'continuous',
    },
    hover: { borderColor: colors.border },
    pressed: { opacity: motion.pressedOpacity },
})
