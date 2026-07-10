import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { RosterTrimBanner } from '@/components/roster/RosterTrimBanner'
import type { RosterPlayer } from '@/lib/roster'

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View',
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null }))
vi.mock('@/lib/roster', () => ({ isIREligible: () => false, isTaxiEligible: () => false }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = (id: string): RosterPlayer => ({
    id: `roster-${id}`,
    is_on_ir: false,
    is_on_taxi: false,
    acquired_via: 'trade',
    players: {
        id,
        display_name: id,
        nba_team: 'LAL',
        position: 'PG',
        eligible_positions: ['PG'],
        injury_status: null,
        nba_id: null,
        nba_draft_number: null,
        years_exp: 1,
    },
})

describe('roster overflow recovery ownership', () => {
    it('disables every recovery action while any roster mutation is in flight', async () => {
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(RosterTrimBanner, {
                players: [player('one'), player('two')],
                excess: 1,
                irAvailable: false,
                taxiAvailable: false,
                busyId: 'roster-one',
                onDrop: vi.fn(),
                onMoveToIR: vi.fn(),
                onMoveToTaxi: vi.fn(),
            }))
        })
        const dropActions = renderer.root.findAll((node) =>
            typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('Drop '))

        expect(dropActions).toHaveLength(2)
        expect(dropActions.every((node) => node.props.disabled === true)).toBe(true)
        await act(async () => { renderer.unmount() })
    })
})
