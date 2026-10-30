import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { LockedAssetNotice } from '@/components/roster/LockedAssetNotice'
import { RosterPlayerItem, TaxiPlayerItem } from '@/components/roster/RosterItems'
import type { RosterPlayer } from '@/lib/roster'

vi.mock('@/lib/format', () => ({ formatPoints: String, playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/roster', () => ({ isIREligible: () => true }))
vi.mock('@/lib/trades', () => ({}))
vi.mock('@/lib/waivers', () => ({}))

const item: RosterPlayer = {
    id: 'roster-player', is_on_ir: false, is_on_taxi: false, acquired_via: 'draft',
    players: {
        id: 'player', display_name: 'Test Player', nba_team: 'LAL', position: 'PG',
        eligible_positions: ['PG'], injury_status: 'Out', nba_id: null, nba_draft_number: 1, years_exp: 0,
    },
}

describe('RosterPlayerItem actions', () => {
    it('keeps row navigation and roster actions as named sibling controls', async () => {
        const onPress = vi.fn()
        const onToggleIR = vi.fn()
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(RosterPlayerItem, {
                item, slotType: 'BE', togglingId: null, taxiingId: null, droppingId: null,
                onPress, onLongPress: vi.fn(), onToggleIR,
            }))
        })
        const open = renderer.root.findByProps({ accessibilityLabel: 'Open Test Player' })
        const ir = renderer.root.findByProps({ accessibilityLabel: 'Move Test Player to IR' })
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Move Test Player to taxi' })).toHaveLength(0)

        expect(open.parent).not.toBe(ir.parent)
        await act(async () => { ir.props.onPress() })
        expect(onToggleIR).toHaveBeenCalledWith(item)
        expect(onPress).not.toHaveBeenCalled()
        await act(async () => { open.props.onPress() })
        expect(onPress).toHaveBeenCalledOnce()
        await act(async () => { renderer.unmount() })
    })

    it('keeps taxi navigation and activation as named sibling controls', async () => {
        const onPress = vi.fn()
        const onToggleTaxi = vi.fn()
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(TaxiPlayerItem, {
                item: { ...item, is_on_taxi: true }, taxiingId: null, onPress, onToggleTaxi,
            }))
        })
        const open = renderer.root.findByProps({ accessibilityLabel: 'Open Test Player' })
        const activate = renderer.root.findByProps({ accessibilityLabel: 'Activate Test Player' })
        expect(open.parent).toBe(activate.parent)
        await act(async () => { activate.props.onPress() })
        expect(onToggleTaxi).toHaveBeenCalledOnce()
        expect(onPress).not.toHaveBeenCalled()
        await act(async () => { open.props.onPress() })
        expect(onPress).toHaveBeenCalledOnce()
        await act(async () => { renderer.unmount() })
    })
})

it('hides Move to IR during offseason and preserves Activate from IR', async () => {
    let renderer!: ReactTestRenderer
    const props = { item, slotType: 'BE', togglingId: null, taxiingId: null, droppingId: null,
        allowIR: false, onPress: vi.fn(), onLongPress: vi.fn(), onToggleIR: vi.fn() }
    await act(async () => { renderer = create(React.createElement(RosterPlayerItem, props)) })
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Move Test Player to IR' })).toHaveLength(0)
    await act(async () => renderer.update(React.createElement(RosterPlayerItem, { ...props, item: { ...item, is_on_ir: true } })))
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Activate Test Player' }).length).toBeGreaterThan(0)
    await act(async () => renderer.unmount())
})

it('keeps player navigation and disables changes while a pending trade reserves the player', async () => {
    const lockedItem: RosterPlayer = { ...item, assetLocks: [{ assetKind: 'player' as const, assetId: 'player', sourceKind: 'trade' as const, sourceId: 'trade-id', reason: 'Cancel trade trade-id first.' }] }
    let renderer!: ReactTestRenderer
    await act(async () => {
        renderer = create(React.createElement(RosterPlayerItem, {
            item: lockedItem, slotType: 'BE', togglingId: null, taxiingId: null, droppingId: null,
            onPress: vi.fn(), onLongPress: vi.fn(), onToggleIR: vi.fn(),
        }))
    })
    expect(renderer.root.findByProps({ accessibilityLabel: 'Move Test Player to IR' }).props.disabled).toBe(true)
    expect(renderer.root.findByProps({ accessibilityLabel: 'Open Test Player' }).props.onLongPress).toBeUndefined()
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Locked by a pending trade' }).length).toBeGreaterThan(0)
    await act(async () => { renderer.unmount() })
})

it('shows one icon for several reservations and explains taps and long presses', async () => {
    const { showAlert } = await import('@/lib/alert')
    let renderer!: ReactTestRenderer
    await act(async () => {
        renderer = create(React.createElement(LockedAssetNotice, {
            locks: ['trade-id', 'another-trade'].map(sourceId => ({ assetKind: 'pick' as const, assetId: 'pick', sourceKind: 'trade' as const, sourceId, reason: 'Cancel this trade.' })),
        }))
    })
    const icon = renderer.root.findByProps({ accessibilityRole: 'button' })
    expect(renderer.root.findAllByType('MaterialIcons' as React.ElementType)).toHaveLength(1)
    expect(renderer.root.findAllByType('Text' as React.ElementType)).toHaveLength(0)
    const stopPropagation = vi.fn()
    await act(async () => { await icon.props.onPress({ stopPropagation }); await icon.props.onLongPress({ stopPropagation }) })
    expect(stopPropagation).toHaveBeenCalledTimes(2)
    expect(showAlert).toHaveBeenLastCalledWith('', 'Locked by a pending trade', 'info')
    await act(async () => { renderer.unmount() })
})

vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
