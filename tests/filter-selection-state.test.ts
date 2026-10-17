import React, { useState } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FilterSelect, MultiSelect } from '@/components/ui/FilterSelect'

vi.mock('react-native', () => ({
    Pressable: 'Pressable', View: 'View', Text: 'Text', Platform: { OS: 'web' },
    StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? children : null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const controls = () => screen.root.findAllByType('Pressable' as React.ElementType)
const named = (name: string) => controls().find((control) => control.props.accessibilityLabel === name)!
const withText = (name: string) => controls().find((control) => !control.props.accessibilityLabel && control.findAllByType('Text' as React.ElementType).some((text) => text.props.children === name))!
const press = (control: ReactTestInstance) => act(async () => { control.props.onPress() })
afterEach(async () => { await act(async () => screen?.unmount()) })

it('announces each team checkbox state after selection and Clear', async () => {
    const Probe = () => {
        const [selected, setSelected] = useState<string[]>([])
        return React.createElement(MultiSelect, { label: 'Team', selected, onChange: setSelected,
            options: [{ key: 'ATL', label: 'Atlanta' }, { key: 'BOS', label: 'Boston' }] })
    }
    await act(async () => { screen = create(React.createElement(Probe)) })
    await press(named('Team: All'))
    expect(named('Atlanta').props['aria-checked']).toBe(false)
    await press(named('Atlanta'))
    expect(named('Atlanta').props['aria-checked']).toBe(true)
    expect(named('Boston').props['aria-checked']).toBe(false)
    await press(named('Clear Team'))
    expect(named('Atlanta').props['aria-checked']).toBe(false)
})

it('announces the current single-choice filter when its sheet reopens', async () => {
    const Probe = () => {
        const [value, setValue] = useState('all')
        return React.createElement(FilterSelect, { label: 'Health', value, onChange: setValue,
            options: [{ key: 'all', label: 'All' }, { key: 'out', label: 'Out' }] })
    }
    await act(async () => { screen = create(React.createElement(Probe)) })
    await press(named('Health: All'))
    expect(withText('All').props['aria-pressed']).toBe(true)
    expect(withText('Out').props['aria-pressed']).toBe(false)
    await press(withText('Out'))
    await press(named('Health: Out'))
    expect(withText('Out').props['aria-pressed']).toBe(true)
    expect(withText('All').props['aria-pressed']).toBe(false)
})
