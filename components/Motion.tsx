import { useEffect, useState, type ReactNode } from 'react'
import {
    AccessibilityInfo,
    Animated,
    Easing,
    Platform,
    Pressable,
    StyleSheet,
    View,
    type PressableProps,
    type StyleProp,
    type ViewStyle,
} from 'react-native'
const PRESS_SPRING = { damping: 16, stiffness: 360, mass: 0.42, useNativeDriver: Platform.OS !== 'web' }
const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export function useReducedMotion() {
    const [reduced, setReduced] = useState(() =>
        typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
    useEffect(() => {
        let active = true
        void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduced(value) })
        const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
        return () => { active = false; subscription.remove() }
    }, [])
    return reduced
}

type MotionPreset = 'fade' | 'rise' | 'pop' | 'slide-left' | 'slide-right'

type MotionViewProps = {
    children: ReactNode
    delay?: number
    preset?: MotionPreset
    style?: StyleProp<ViewStyle>
}

export function MotionView({
    children,
    style,
}: MotionViewProps) {
    return <View style={style}>{children}</View>
}

type MotionPressableProps = Omit<PressableProps, 'style'> & {
    children: ReactNode
    disabled?: boolean
    disabledOpacity?: number
    lift?: number
    pressedScale?: number
    style?: StyleProp<ViewStyle>
}

export function MotionPressable({
    children,
    disabled,
    disabledOpacity = 0.58,
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
    const [pressed] = useState(() => new Animated.Value(0))
    const [hovered] = useState(() => new Animated.Value(0))

    const animatedStyle = {
        opacity: disabled ? disabledOpacity : 1,
        transform: [
            { translateY: hovered.interpolate({ inputRange: [0, 1], outputRange: [0, -lift] }) },
            { scale: pressed.interpolate({ inputRange: [0, 1], outputRange: [1, pressedScale] }) },
        ],
    }

    useEffect(() => {
        if (!reduceMotion && !disabled) return
        pressed.stopAnimation()
        hovered.stopAnimation()
        pressed.setValue(0)
        hovered.setValue(0)
    }, [reduceMotion, disabled, pressed, hovered])

    return (
        <AnimatedPressable
            {...props}
            disabled={disabled}
            style={[style, animatedStyle]}
            onHoverIn={(event) => {
                if (!reduceMotion && !disabled) {
                    Animated.spring(hovered, { ...PRESS_SPRING, toValue: 1 }).start()
                }
                onHoverIn?.(event)
            }}
            onHoverOut={(event) => {
                if (!reduceMotion) {
                    Animated.spring(hovered, { ...PRESS_SPRING, toValue: 0 }).start()
                }
                onHoverOut?.(event)
            }}
            onPressIn={(event) => {
                if (!reduceMotion && !disabled) {
                    Animated.spring(pressed, { ...PRESS_SPRING, toValue: 1 }).start()
                }
                onPressIn?.(event)
            }}
            onPressOut={(event) => {
                if (!reduceMotion) {
                    Animated.spring(pressed, { ...PRESS_SPRING, toValue: 0 }).start()
                }
                onPressOut?.(event)
            }}
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
    const [pulse] = useState(() => new Animated.Value(0))

    useEffect(() => {
        if (reduceMotion) {
            pulse.setValue(0)
            return
        }
        const animation = Animated.loop(Animated.sequence([
            Animated.timing(pulse, { toValue: 1, duration: 820, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== 'web', isInteraction: false }),
            Animated.timing(pulse, { toValue: 0, duration: 820, easing: Easing.in(Easing.quad), useNativeDriver: Platform.OS !== 'web', isInteraction: false }),
        ]))
        animation.start()
        return () => animation.stop()
    }, [pulse, reduceMotion])

    const ringStyle = {
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.38, 0] }),
        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.5] }) }],
    }

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
