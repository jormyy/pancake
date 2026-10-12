import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { rosterPlayer } from './helpers/fixtures'
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View', Text: 'Text', StyleSheet: { create: (s: unknown) => s } }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('returns to the remaining IR player after the first full-roster activation', async () => {
    const player = rosterPlayer().players
    const a = rosterPlayer({ id: 'ir-a', is_on_ir: true, players: { ...player, id: 'a', display_name: 'IR A' } })
    const b = rosterPlayer({ id: 'ir-b', is_on_ir: true, players: { ...player, id: 'b', display_name: 'IR B' } })
    const drop1 = rosterPlayer({ id: 'drop-1', players: { ...player, display_name: 'Drop One' } })
    const drop2 = rosterPlayer({ id: 'drop-2', players: { ...player, display_name: 'Drop Two' } })
    const onDropAndActivate = vi.fn().mockResolvedValue(undefined)
    const props = { visible: true, ineligibleIR: [a, b], activeRoster: [drop1, drop2], rosterSize: 2,
        pendingPlayerName: 'Pickup', onActivate: vi.fn(), onDropAndActivate, onCancel: vi.fn() }
    let r!: ReactTestRenderer
    await act(async () => { r = create(React.createElement(IRResolutionModal, props)) })
    const press = async (name: string) => {
        const button = r.root.findByProps({ accessibilityLabel: name })
        await act(async () => { await button.props.onPress() })
    }
    try {
        await press('Activate IR A')
        await press('Drop Drop One')
        expect(onDropAndActivate).toHaveBeenLastCalledWith(drop1, a)
        await act(async () => { r.update(React.createElement(IRResolutionModal, { ...props,
            ineligibleIR: [b], activeRoster: [{ ...a, is_on_ir: false }, drop2] })) })
        expect(r.root.findAllByProps({ accessibilityLabel: 'Drop Drop Two' })).toHaveLength(0)
        await press('Activate IR B')
        await press('Drop Drop Two')
        expect(onDropAndActivate).toHaveBeenLastCalledWith(drop2, b)
    } finally { await act(async () => { r.unmount() }) }
})
