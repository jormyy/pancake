import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { DraftTimerControl } from '@/components/league/DraftChips'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/lib/draft', () => ({ NOMINATION_ORDER_MODES: [], NOMINATION_ORDER_MODE_LABELS: {}, ROOKIE_TIMER_EXPIRY_BEHAVIORS: [], ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS: {} }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([false, true])('uses the right custom timer unit after switching from rookie=%s', async rookie => {
    const onSelect = vi.fn()
    const props = { selectedValue: 60, onSelect, groupLabel: 'Timer', rookie }
    let screen!: ReactTestRenderer
    try {
        await act(async () => { screen = create(React.createElement(DraftTimerControl, props)) })
        await act(async () => screen.update(React.createElement(DraftTimerControl, { ...props, rookie: !rookie })))
        const input = screen.root.findByType('TextInput' as React.ElementType)
        expect(input.props.placeholder).toBe(rookie ? 'sec' : 'min')
        await act(async () => input.props.onChangeText('90'))
        expect(onSelect).toHaveBeenLastCalledWith(rookie ? 90 : 5400)
    } finally { await act(async () => screen.unmount()) }
})

it('keeps minutes while typing a custom duration after an auction-to-rookie switch', async () => {
    const Probe = ({ rookie }: { rookie: boolean }) => {
        const [value, setValue] = React.useState(60)
        return React.createElement(DraftTimerControl, { selectedValue: value, onSelect: setValue, groupLabel: 'Timer', rookie })
    }
    let screen!: ReactTestRenderer
    try {
        await act(async () => { screen = create(React.createElement(Probe, { rookie: false })) })
        await act(async () => screen.update(React.createElement(Probe, { rookie: true })))
        await act(async () => screen.root.findByType('TextInput' as React.ElementType).props.onChangeText('120'))
        expect(screen.root.findByType('TextInput' as React.ElementType).props.placeholder).toBe('min')
        expect(screen.root.findByType('TextInput' as React.ElementType).props.value).toBe('120')
    } finally { await act(async () => screen.unmount()) }
})
