import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeBlockNoteEditor } from '@/components/trades/TradeBlockNoteEditor'
import { isPwaUpdateHeld } from '@/lib/pwa-update-guard'
import type { TradeBlockItem } from '@/lib/trades'

vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))

it('retains a failed note edit and closes only after a successful save', async () => {
    vi.stubGlobal('window', new EventTarget())
    const item: TradeBlockItem = { id: 'listing', memberId: 'member', teamName: 'Team', updatedAt: '', note: null,
        asset: { kind: 'pick', pickId: 'pick', seasonYear: 2028, round: 1, originalTeamName: 'Team' } }
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeBlockNoteEditor, { item, label: '2028 pick', disabled: false, onSave })) })
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Edit trade block note for 2028 pick' }).props.onPress())
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Trade block note for 2028 pick' }).props.onChangeText('Young guards'))
    expect(isPwaUpdateHeld()).toBe(true)
    await act(async () => { await renderer.root.findByProps({ title: 'Save note' }).props.onPress() })
    expect(onSave).toHaveBeenLastCalledWith(item, 'Young guards')
    expect(renderer.root.findByProps({ accessibilityLabel: 'Trade block note for 2028 pick' }).props.value).toBe('Young guards')
    await act(async () => { await renderer.root.findByProps({ title: 'Save note' }).props.onPress() })
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Trade block note for 2028 pick' })).toHaveLength(0)
    expect(isPwaUpdateHeld()).toBe(false)
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
})
