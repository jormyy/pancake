import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { rosterPlayer } from '@/tests/helpers/fixtures'

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/player/PlayerAvatar', () => ({ PlayerAvatar: 'PlayerAvatar' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => [] }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer

afterEach(async () => { await act(async () => screen?.unmount()) })

it('keeps drop and IR choices in the same order when roster rows arrive in another order', async () => {
    const make = (id: string, name: string) => rosterPlayer({ id, players: { ...rosterPlayer().players, display_name: name } })
    const adams = make('a', 'Adams'), baker = make('b', 'Baker')
    const roster = [baker, adams]
    const props = { visible: true, title: 'Add a player', roster, irMoveCandidates: roster, dropping: null, onDrop: vi.fn(), onMoveToIR: vi.fn(), onCancel: vi.fn() }
    const labels = () => screen.root.findAllByType('Button' as React.ElementType).map(node => node.props.accessibilityLabel)
    const expected = ['Move Adams to IR and add player', 'Move Baker to IR and add player', 'Drop Adams', 'Drop Baker']
    await act(async () => { screen = create(React.createElement(DropPlayerPickerModal, props)) })
    expect(labels()).toEqual(expected)
    expect(roster).toEqual([baker, adams])
    await act(async () => screen.update(React.createElement(DropPlayerPickerModal, { ...props, roster: [adams, baker], irMoveCandidates: [adams, baker] })))
    expect(labels()).toEqual(expected)
})

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))

it('separates drop choices into Roster, IR and Taxi and hides empty sections', async () => {
    const make = (id: string, name: string, slot: { is_on_ir?: boolean; is_on_taxi?: boolean }) => rosterPlayer({ id, ...slot, players: { ...rosterPlayer().players, display_name: name } })
    const roster = [make('t', 'Taxi Tim', { is_on_taxi: true }), make('i', 'Injured Ian', { is_on_ir: true }), make('a', 'Active Amy', {})]
    const props = { visible: true, title: 'Add a player', roster, dropping: null, onDrop: vi.fn(), onCancel: vi.fn() }
    const sections = () => screen.root.findAll(node => node.props.accessibilityRole === 'header' && node.type === ('Text' as React.ElementType))
        .map(node => node.props.children)
    const drops = () => screen.root.findAllByType('Button' as React.ElementType).map(node => node.props.accessibilityLabel)
    await act(async () => { screen = create(React.createElement(DropPlayerPickerModal, props)) })
    expect(sections()).toEqual(['Roster', 'IR', 'Taxi'])
    expect(drops()).toEqual(['Drop Active Amy', 'Drop Injured Ian', 'Drop Taxi Tim'])
    await act(async () => screen.update(React.createElement(DropPlayerPickerModal, { ...props, roster: [roster[2]] })))
    expect(sections()).toEqual(['Roster'])
})
