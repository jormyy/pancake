import { useEffect } from 'react'
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming, cancelAnimation } from 'react-native-reanimated'
import { colors, radii } from '@/constants/tokens'

type Props = {
    width?: DimensionValue
    height?: number
    radius?: keyof typeof radii | number
    style?: StyleProp<ViewStyle>
}

/** Shimmering placeholder block for loading states (reduced-motion → static). */
export function Skeleton({ width = '100%', height = 14, radius = 'sm', style }: Props) {
    const reduceMotion = useReducedMotion()
    const shimmer = useSharedValue(0.5)

    useEffect(() => {
        if (reduceMotion) {
            shimmer.value = 0.55
            return
        }
        shimmer.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true)
        return () => cancelAnimation(shimmer)
    }, [reduceMotion, shimmer])

    const animatedStyle = useAnimatedStyle(() => ({ opacity: shimmer.value }))
    const br = typeof radius === 'number' ? radius : radii[radius]

    return (
        <Animated.View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.base, { width, height, borderRadius: br }, animatedStyle, style]}
        />
    )
}

/** Convenience: a vertical stack of skeleton rows (for list loading). */
export function SkeletonRows({ count = 6, height = 56, gap = 10 }: { count?: number; height?: number; gap?: number }) {
    return (
        <View style={{ gap }}>
            {Array.from({ length: count }).map((_, i) => (
                <Skeleton key={i} height={height} radius="xl" />
            ))}
        </View>
    )
}

const styles = StyleSheet.create({
    base: {
        backgroundColor: colors.bgMuted,
    },
})
