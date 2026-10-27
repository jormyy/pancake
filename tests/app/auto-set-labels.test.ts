import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { AutoSetModal } from '@/components/AutoSetModal'

vi.mock('react-native', () => ({ View: 'View', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('names each auto-set period and keeps the manual editor action', async () => {
    const actions = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    let screen: ReturnType<typeof create>
    try {
        await act(async () => { screen = create(React.createElement(AutoSetModal, { visible: true, disabled: false, onClose: vi.fn(), onToday: actions[0], onWholeWeek: actions[1], onRestOfSeason: actions[2], onEditManually: actions[3] })) })
        const buttons = screen!.root.findAllByType('Button' as React.ElementType)
        expect(buttons.map(button => button.props.title)).toEqual(['Today', 'This week', 'Rest of season', 'Edit lineup manually'])
        for (const button of buttons) await act(async () => button.props.onPress())
        for (const action of actions) expect(action).toHaveBeenCalledOnce()
    } finally { await act(async () => screen?.unmount()) }
})
