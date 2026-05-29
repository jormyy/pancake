import { useEffect, type ReactNode } from 'react'
import {
    Pressable,
    StyleSheet,
    View,
    type PressableProps,
    type StyleProp,
    type ViewStyle,
} from 'react-native'
import Animated, {
    Easing,
    cancelAnimation,
    interpolate,
    useAnimatedStyle,
    useReducedMotion,
    useSharedValue,
    withDelay,
    withRepeat,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated'

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

const ENTER_SPRING = { damping: 18, stiffness: 210, mass: 0.72 }
const PRESS_SPRING = { damping: 16, stiffness: 360, mass: 0.42 }

type MotionPreset = 'fade' | 'rise' | 'pop' | 'slide-left' | 'slide-right'

type MotionViewProps = {
    children: ReactNode
    delay?: number
    preset?: MotionPreset
    style?: StyleProp<ViewStyle>
}

export function MotionView({
    children,
    delay = 0,
    preset = 'rise',
    style,
}: MotionViewProps) {
    const reduceMotion = useReducedMotion()
    const progress = useSharedValue(reduceMotion ? 1 : 0)

    useEffect(() => {
        progress.value = reduceMotion
            ? 1
            : withDelay(delay, withSpring(1, ENTER_SPRING))
    }, [delay, progress, reduceMotion])

    const animatedStyle = useAnimatedStyle(() => {
        const y = preset === 'rise' ? interpolate(progress.value, [0, 1], [14, 0]) : 0
        const x =
            preset === 'slide-left'
                ? interpolate(progress.value, [0, 1], [18, 0])
                : preset === 'slide-right'
                  ? interpolate(progress.value, [0, 1], [-18, 0])
                  : 0
        const scale = preset === 'pop' ? interpolate(progress.value, [0, 1], [0.92, 1]) : 1

        return {
            opacity: progress.value,
            transform: [{ translateX: x }, { translateY: y }, { scale }],
        }
    }, [preset])

    return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
}

type MotionPressableProps = Omit<PressableProps, 'style'> & {
    children: ReactNode
    disabled?: boolean
    lift?: number
    pressedScale?: number
    style?: StyleProp<ViewStyle>
}

export function MotionPressable({
    children,
    disabled,
    lift = 1.5,
    onHoverIn,
    onHoverOut,
    onPressIn,
    onPressOut,
    pressedScale = 0.965,
    style,
    ...props
}: MotionPressableProps) {
    const reduceMotion = useReducedMotion()
    const pressed = useSharedValue(0)
    const hovered = useSharedValue(0)

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: disabled ? 0.58 : 1,
        transform: [
            { translateY: -hovered.value * lift },
            { scale: 1 - pressed.value * (1 - pressedScale) },
        ],
    }), [disabled, lift, pressedScale])

    return (
        <AnimatedPressable
            {...props}
            disabled={disabled}
            onHoverIn={(event) => {
                if (!reduceMotion && !disabled) {
                    hovered.value = withSpring(1, PRESS_SPRING)
                }
                onHoverIn?.(event)
            }}
            onHoverOut={(event) => {
                if (!reduceMotion) {
                    hovered.value = withSpring(0, PRESS_SPRING)
                }
                onHoverOut?.(event)
            }}
            onPressIn={(event) => {
                if (!reduceMotion && !disabled) {
                    pressed.value = withSpring(1, PRESS_SPRING)
                }
                onPressIn?.(event)
            }}
            onPressOut={(event) => {
                if (!reduceMotion) {
                    pressed.value = withSpring(0, PRESS_SPRING)
                }
                onPressOut?.(event)
            }}
            style={[style, animatedStyle]}
        >
            {children}
        </AnimatedPressable>
    )
}

export function LivePulse({
    color,
    size = 6,
    style,
}: {
    color: string
    size?: number
    style?: StyleProp<ViewStyle>
}) {
    const reduceMotion = useReducedMotion()
    const pulse = useSharedValue(0)

    useEffect(() => {
        if (reduceMotion) {
            pulse.value = 0
            return
        }
        pulse.value = withRepeat(
            withSequence(
                withTiming(1, { duration: 820, easing: Easing.out(Easing.quad) }),
                withTiming(0, { duration: 820, easing: Easing.in(Easing.quad) }),
            ),
            -1,
            false,
        )
        return () => cancelAnimation(pulse)
    }, [pulse, reduceMotion])

    const ringStyle = useAnimatedStyle(() => ({
        opacity: interpolate(pulse.value, [0, 1], [0.38, 0]),
        transform: [{ scale: interpolate(pulse.value, [0, 1], [1, 2.5]) }],
    }))

    return (
        <View
            style={[
                styles.pulseHost,
                { width: size, height: size, borderRadius: size / 2 },
                style,
            ]}
        >
            <Animated.View
                style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: color, borderRadius: size / 2 },
                    ringStyle,
                ]}
            />
            <View
                style={[
                    styles.pulseCore,
                    { backgroundColor: color, borderRadius: size / 2 },
                ]}
            />
        </View>
    )
}

const styles = StyleSheet.create({
    pulseHost: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    pulseCore: {
        width: '100%',
        height: '100%',
    },
})
