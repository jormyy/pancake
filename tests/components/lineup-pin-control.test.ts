import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { LineupPinControl } from '@/components/LineupPinControl'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, View: 'View', Text: 'Text',
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'Pressable' }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ visible, title, children }: { visible: boolean; title: string; children: React.ReactNode }) => visible ? React.createElement('Sheet', { title }, children) : null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('announces one selected pin and sends the chosen role', async () => {
    const onChange = vi.fn()
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LineupPinControl, { name: 'Player', pin: null, disabled: false, onChange })) })
    try {
        const radios = screen.root.findAllByProps({ accessibilityRole: 'radio' })
        expect(radios.map(radio => radio.props['aria-checked'])).toEqual([false, true, false])
        await act(async () => { radios[0].props.onPress({ stopPropagation: vi.fn() }) })
        expect(onChange).toHaveBeenCalledWith('start')
        await act(async () => { screen.update(React.createElement(LineupPinControl, { name: 'Player', pin: 'start', disabled: true, onChange })) })
        expect(radios.map(radio => radio.props['aria-checked'])).toEqual([true, false, false])
        onChange.mockClear()
        await act(async () => { radios[2].props.onPress({ stopPropagation: vi.fn() }) })
        expect(onChange).not.toHaveBeenCalled()
    } finally {
        await act(async () => screen.unmount())
    }
})

it('shows the current pin as one compact control and opens every choice in a sheet', async () => {
    const onChange = vi.fn()
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(LineupPinControl, { name: 'Player', pin: 'bench', disabled: false, onChange, compact: true })) })
    try {
        expect(screen.root.findAllByProps({ accessibilityRole: 'radio' })).toHaveLength(0)
        const trigger = screen.root.findByProps({ accessibilityLabel: 'Lineup pin for Player: Bench' })
        await act(async () => { trigger.props.onPress({ stopPropagation: vi.fn() }) })
        expect(screen.root.findByType('Sheet' as React.ElementType).props.title).toBe('Pin Player')
        const radios = screen.root.findAllByProps({ accessibilityRole: 'radio' })
        expect(radios.map(radio => radio.props['aria-checked'])).toEqual([false, false, true])
        await act(async () => { radios[1].props.onPress({ stopPropagation: vi.fn() }) })
        expect(onChange).toHaveBeenCalledExactlyOnceWith(null)
        expect(screen.root.findAllByType('Sheet' as React.ElementType)).toHaveLength(0)
    } finally {
        await act(async () => screen.unmount())
    }
})
