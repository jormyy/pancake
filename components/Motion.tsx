import { useEffect, useState, type ReactNode } from 'react'
import {
    AccessibilityInfo,
    Pressable,
    View,
    type PressableProps,
    type StyleProp,
    type ViewStyle,
} from 'react-native'
import { motion, spacing } from '@/constants/tokens'

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
    lift: _lift,
    pressedScale: _pressedScale,
    style,
    ...props
}: MotionPressableProps) {
    return (
        <Pressable
            {...props}
            disabled={disabled}
            style={({ pressed }) => [style, { opacity: disabled ? disabledOpacity : pressed ? motion.pressedOpacity : 1 }]}
        >
            {children}
        </Pressable>
    )
}

export function LivePulse({
    color,
    size = spacing.sm,
    style,
}: {
    color: string
    size?: number
    style?: StyleProp<ViewStyle>
}) {
    return <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />
}
