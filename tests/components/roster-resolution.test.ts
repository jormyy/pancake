import '../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { RosterPlayerSheet } from '@/components/roster/RosterPlayerSheet'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { rosterPlayer } from '../helpers/fixtures'

vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children, visible, ...props }: React.PropsWithChildren<{ visible: boolean }>) => visible ? React.createElement('Sheet', props, children) : null }))
let screen: ReactTestRenderer
const taxi = rosterPlayer({ id: 'taxi', is_on_taxi: true })
taxi.players = { ...taxi.players, display_name: 'Taxi A', years_exp: 2, career_regular_season_games: 65, injury_status: 'Out' }
afterEach(async () => { await act(async () => screen?.unmount()) })

it('activates taxi through the drop workflow and keeps IR and taxi copy distinct', async () => {
    const active = rosterPlayer()
    const drop = vi.fn()
    const props = { visible: true, ineligibleIR: [taxi], activeRoster: [active], rosterSize: 1, pendingPlayerName: 'New player', onActivate: vi.fn(), onDropAndActivate: drop, onCancel: vi.fn() }
    await act(async () => { screen = create(React.createElement(IRResolutionModal, props)) })
    await act(async () => screen.root.findByProps({ accessibilityLabel: `Activate ${taxi.players.display_name}` }).props.onPress())
    expect(JSON.stringify(screen.toJSON())).toContain('taxi')
    expect(JSON.stringify(screen.toJSON())).not.toContain('from IR')
    await act(async () => screen.root.findByProps({ accessibilityLabel: `Drop ${active.players.display_name}` }).props.onPress())
    expect(drop).toHaveBeenCalledWith(active, taxi)
})

it('offers direct Drop and Move to IR fixes for taxi and active overflow together', async () => {
    const active = rosterPlayer({ id: 'active' })
    active.players = { ...active.players, display_name: 'Active A' }
    const move = vi.fn(), drop = vi.fn()
    await act(async () => { screen = create(React.createElement(IRResolutionModal, {
        visible: true, ineligibleIR: [taxi], activeRoster: [active], rosterSize: 0, pendingPlayerName: '', irAvailable: true,
        onActivate: vi.fn(), onDropAndActivate: vi.fn(), onDrop: drop, onMoveToIR: move, onCancel: vi.fn(),
    })) })
    expect(JSON.stringify(screen.toJSON())).toContain('over the limit')
    await act(async () => screen.root.findAllByProps({ accessibilityLabel: `Move ${taxi.players.display_name} to IR` })[0].props.onPress())
    expect(move).toHaveBeenCalledWith(taxi)
    await act(async () => screen.root.findAllByProps({ accessibilityLabel: `Drop ${active.players.display_name}` })[0].props.onPress())
    expect(drop).toHaveBeenCalledWith(active)
})

it('puts taxi before drop choices and includes Add only with active room', async () => {
    const props = { visible: true, title: 'Add', roster: [rosterPlayer()], dropping: null, onDrop: vi.fn(), onAddToTaxi: vi.fn(), onAdd: vi.fn(), onCancel: vi.fn() }
    await act(async () => { screen = create(React.createElement(DropPlayerPickerModal, props)) })
    const actions = () => screen.root.findAllByType('Pressable' as React.ElementType).map(node => node.props.accessibilityLabel ?? node.findAllByType('Text' as React.ElementType).map(text => text.props.children).join(''))
    expect(actions()).toEqual(['Add', 'Add to taxi', 'Drop Player A'])
    await act(async () => screen.update(React.createElement(DropPlayerPickerModal, { ...props, onAdd: undefined })))
    expect(actions()).toEqual(['Add to taxi', 'Drop Player A'])
})

it.each([true, false])('describes the add destination accurately with active room %s', async canAddActive => {
    const add = vi.fn(), taxi = vi.fn()
    await act(async () => { screen = create(React.createElement(DropPlayerPickerModal, {
        visible: true, title: 'Add Player B', roster: [rosterPlayer()], dropping: null,
        onDrop: vi.fn(), onAdd: canAddActive ? add : undefined, onAddToTaxi: taxi, onCancel: vi.fn(),
    })) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(text).toContain(canAddActive ? 'Choose where to add this player.' : 'Roster full')
    if (canAddActive) expect(text).not.toContain('Roster full')
    await act(async () => screen.root.findAllByType('Pressable' as React.ElementType).find(node => node.props.accessibilityLabel === 'Add to taxi')!.props.onPress())
    expect(taxi).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
})

it('shows age before experience in the roster player sheet', async () => {
    const player = rosterPlayer()
    player.players = { ...player.players, birthdate: '1990-01-01', years_exp: 10 }
    await act(async () => { screen = create(React.createElement(RosterPlayerSheet, { player, actions: [], onClose: vi.fn() })) })
    const text = JSON.stringify(screen.toJSON())
    expect(text).toContain('Yr 11')
    expect(text.indexOf('36')).toBeLessThan(text.indexOf('Yr 11'))
})

it.each(['trade', 'claim'] as const)('keeps the drop action disabled with its pending %s message', async (sourceKind) => {
    const player = { ...rosterPlayer(), assetLocks: [{ assetKind: 'player' as const, assetId: 'player', sourceKind,
        sourceId: 'reservation', reason: `Locked by ${sourceKind}. Cancel it to drop this player.` }] }
    await act(async () => { screen = create(React.createElement(RosterPlayerSheet, {
        player, actions: [{ key: 'drop', label: 'Drop player', icon: 'delete', onPress: vi.fn() }], onClose: vi.fn(),
    })) })
    expect(screen.root.findByProps({ accessibilityLabel: 'Drop player' }).props.disabled).toBe(true)
    expect(screen.root.findAllByProps({ accessibilityLabel: `Locked by a pending ${sourceKind === 'trade' ? 'trade' : 'waiver claim'}` })).toHaveLength(1)
    expect(JSON.stringify(screen.toJSON())).not.toContain('Cancel it to drop this player.')
})

it('labels Taxi drops and offers replacement when Active cannot accept the pickup', async () => {
    const drop = vi.fn()
    await act(async () => { screen = create(React.createElement(DropPlayerPickerModal, {
        visible: true, title: 'Add', roster: [taxi], dropping: null, onDrop: drop, onCancel: vi.fn(),
        destinations: () => ({ active: false, taxi: true, ir: false }),
    })) })
    expect(JSON.stringify(screen.toJSON())).toContain('Taxi')
    const buttons = screen.root.findAllByType('Pressable' as React.ElementType)
    expect(buttons.find(node => node.props.accessibilityLabel === 'Drop Taxi A')!.props.disabled).toBe(true)
    await act(async () => buttons.find(node => node.props.accessibilityLabel === 'Drop Taxi A and add to Taxi')!.props.onPress())
    expect(drop).toHaveBeenCalledExactlyOnceWith(taxi, 'taxi')
})
