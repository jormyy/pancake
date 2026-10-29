import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { AutoSetModal } from '@/components/AutoSetModal'

vi.mock('react-native', () => ({ View: 'View', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('offers only manual editing and keeps its action usable', async () => {
    const editManually = vi.fn()
    let screen: ReturnType<typeof create>
    try {
        await act(async () => { screen = create(React.createElement(AutoSetModal, { visible: true, onClose: vi.fn(), onEditManually: editManually })) })
        const buttons = screen!.root.findAllByType('Button' as React.ElementType)
        expect(buttons.map(button => button.props.title)).toEqual(['Edit lineup manually'])
        for (const button of buttons) await act(async () => button.props.onPress())
        expect(editManually).toHaveBeenCalledOnce()
    } finally { await act(async () => screen?.unmount()) }
})
