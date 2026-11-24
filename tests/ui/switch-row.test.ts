import React from 'react'
import { act, create } from 'react-test-renderer'
import { StyleSheet } from 'react-native'
import { expect, it, vi } from 'vitest'
import { controlSize } from '@/constants/tokens'

vi.mock('react-native', async () => await vi.importActual('react-native-web'))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'MotionPressable' }))

it('makes the whole row one labelled switch at least a touch target tall that toggles on tap', async () => {
    const { SwitchRow } = await import('@/components/ui/SwitchRow')
    const onValueChange = vi.fn()
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(SwitchRow, { accessibilityLabel: 'Receive this auction player into taxi', value: true, onValueChange }, 'Receive this auction player into taxi')) })
    const row = screen.root.findByType('MotionPressable' as never)
    expect(row.props).toMatchObject({ accessibilityRole: 'switch', 'aria-checked': true, accessibilityLabel: 'Receive this auction player into taxi' })
    expect(StyleSheet.flatten(row.props.style).minHeight).toBeGreaterThanOrEqual(controlSize.minTouch)
    expect(screen.root.findAll(node => node.props.accessibilityLabel === 'Receive this auction player into taxi' && typeof node.type === 'string')).toHaveLength(1)
    await act(async () => row.props.onPress())
    expect(onValueChange).toHaveBeenCalledWith(false)
})
