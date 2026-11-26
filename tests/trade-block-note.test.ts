import './helpers/native-component-mocks'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { TradeBlockNoteButton, TradeBlockNoteEditor } from '@/components/trades/TradeBlockNoteEditor'
import { isPwaUpdateHeld } from '@/lib/pwa-update-guard'
import type { TradeBlockItem } from '@/lib/trades'
import { storedDraftYear } from '@/lib/picks'

vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))

const item: TradeBlockItem = { id: 'listing', memberId: 'member', teamName: 'Team', updatedAt: '', note: null,
    asset: { kind: 'pick', pickId: 'pick', seasonYear: storedDraftYear(2028), round: 1, originalTeamName: 'Team' } }

function NoteHarness({ onSave }: { onSave: (item: TradeBlockItem, note: string) => Promise<boolean | undefined> }) {
    const [open, setOpen] = React.useState(false)
    return open
        ? React.createElement(TradeBlockNoteEditor, { item, label: '2028 pick', disabled: false, onSave, onClose: () => setOpen(false) })
        : React.createElement(TradeBlockNoteButton, { label: '2028 pick', disabled: false, onPress: () => setOpen(true) })
}

it('labels the note action on the row itself', async () => {
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(TradeBlockNoteButton, { label: '2028 pick', disabled: false, onPress: () => {} })) })
    const labels = renderer.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(labels).toContain('Note')
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Edit trade block note for 2028 pick' })).toHaveLength(1)
    await act(async () => renderer.unmount())
})

it('retains a failed note edit and closes only after a successful save', async () => {
    vi.stubGlobal('window', new EventTarget())
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(NoteHarness, { onSave })) })
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Edit trade block note for 2028 pick' }).props.onPress())
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Trade block note for 2028 pick' }).props.onChangeText('Young guards'))
    expect(isPwaUpdateHeld()).toBe(true)
    await act(async () => { await renderer.root.findByProps({ title: 'Save note' }).props.onPress() })
    expect(onSave).toHaveBeenLastCalledWith(item, 'Young guards')
    expect(renderer.root.findByProps({ accessibilityLabel: 'Trade block note for 2028 pick' }).props.value).toBe('Young guards')
    await act(async () => { await renderer.root.findByProps({ title: 'Save note' }).props.onPress() })
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Trade block note for 2028 pick' })).toHaveLength(0)
    expect(isPwaUpdateHeld()).toBe(false)
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Edit trade block note for 2028 pick' })).toHaveLength(1)
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
})
