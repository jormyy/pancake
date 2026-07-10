import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { RosterPlayerItem, TaxiPlayerItem } from '@/components/roster/RosterItems'
import type { RosterPlayer } from '@/lib/roster'

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    NativeModules: { BlobModule: null },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}))
vi.mock('@/components/Motion', () => ({
    MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Pressable', props, children),
    MotionView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('View', props, children),
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/lib/format', () => ({ formatPoints: String, playerHeadshotUrl: () => null }))
vi.mock('@/lib/players', () => ({ getEligiblePositions: () => ['PG'] }))
vi.mock('@/lib/roster', () => ({ isIREligible: () => true, isTaxiEligible: () => true }))
vi.mock('@/lib/trades', () => ({}))
vi.mock('@/lib/waivers', () => ({}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
        const onToggleTaxi = vi.fn()
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(RosterPlayerItem, {
                item, togglingId: null, taxiingId: null, droppingId: null,
                taxiSlotsAvailable: true, onPress, onLongPress: vi.fn(), onToggleIR, onToggleTaxi,
            }))
        })
        const open = renderer.root.findByProps({ accessibilityLabel: 'Open Test Player' })
        const ir = renderer.root.findByProps({ accessibilityLabel: 'Move Test Player to IR' })
        const taxi = renderer.root.findByProps({ accessibilityLabel: 'Move Test Player to taxi' })

        expect(open.parent).not.toBe(ir.parent)
        expect(open.parent).not.toBe(taxi.parent)
        await act(async () => { ir.props.onPress() })
        expect(onToggleIR).toHaveBeenCalledWith(item)
        expect(onPress).not.toHaveBeenCalled()
        await act(async () => { taxi.props.onPress() })
        expect(onToggleTaxi).toHaveBeenCalledWith(item)
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
