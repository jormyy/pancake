import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LivePulse, MotionPressable } from '@/components/Motion'
import { Sheet } from '@/components/ui/Sheet'

const animation = vi.hoisted(() => ({ loop: vi.fn(), spring: vi.fn() }))
vi.mock('react-native', () => {
    const task = () => ({ start: vi.fn(), stop: vi.fn() })
    animation.loop.mockImplementation(task)
    animation.spring.mockImplementation(task)
    return {
        View: 'View', Text: 'Text', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView',
        Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
        useWindowDimensions: () => ({ width: 402, height: 874 }),
        AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: vi.fn() }) },
        Easing: { in: vi.fn(), out: vi.fn(), quad: vi.fn() },
        Animated: {
            createAnimatedComponent: () => 'AnimatedPressable', View: 'AnimatedView',
            Value: class {
                interpolate() { return 0 }
                stopAnimation() {}
                setValue() {}
            },
            timing: task, sequence: task, loop: animation.loop, spring: animation.spring,
        },
    }
})
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
beforeEach(() => { vi.clearAllMocks() })
afterEach(async () => { await act(async () => screen?.unmount()) })

it('shows live status without starting a repeating animation', async () => {
    await act(async () => { screen = create(React.createElement(LivePulse, { color: 'green' })) })
    expect(animation.loop).not.toHaveBeenCalled()
    expect(screen.root.findAllByType('AnimatedView' as React.ElementType)).toHaveLength(0)
})

it('keeps action controls in place through a tap and preserves event handlers', async () => {
    const onPressIn = vi.fn(), onPressOut = vi.fn()
    const props = { onPressIn, onPressOut, children: 'Add' }
    await act(async () => {
        screen = create(React.createElement(MotionPressable, props))
    })
    const control = screen.root.find(node => typeof node.type === 'string' && typeof node.props.onPressIn === 'function')
    await act(async () => { control.props.onPressIn({}); control.props.onPressOut({}) })
    expect(onPressIn).toHaveBeenCalledOnce()
    expect(onPressOut).toHaveBeenCalledOnce()
    expect(animation.spring).not.toHaveBeenCalled()
})

it('presents installed web sheets in their final position on the first frame', async () => {
    const props = { visible: true, title: 'Menu', onClose: vi.fn(), children: 'Profile' }
    await act(async () => {
        screen = create(React.createElement(Sheet, props))
    })
    expect(screen.root.findByType('Modal' as React.ElementType).props.animationType).toBe('none')
})
