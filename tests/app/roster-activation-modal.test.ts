import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ActivationOverflowModal } from '@/components/ActivationOverflowModal'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/lib/roster', () => ({ isIREligible: () => true }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null }))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const player = { rosterPlayerId: 'active', playerId: 'player', displayName: 'Active', position: 'PG', eligiblePositions: ['PG'], nbaTeam: 'BOS', injuryStatus: 'Out', nbaId: null }
afterEach(async () => { await act(async () => screen?.unmount()) })

it.each([0, 1, 2])('offers IR only if one of %s slots remains', async irSlots => {
    const props = { pending: { rosterPlayerId: 'reserve', source: 'taxi' as const },
        myLineup: { starters: [], bench: [player], ir: [player], taxi: [] }, saving: false,
        irSlots, onDrop: vi.fn(), onMoveToIR: vi.fn(), onCancel: vi.fn() }
    await act(async () => { screen = create(React.createElement(ActivationOverflowModal, props)) })
    const buttons = screen.root.findAllByType('Button' as React.ElementType)
    expect(buttons.filter(button => button.props.title === 'IR')).toHaveLength(irSlots > 1 ? 1 : 0)
    expect(buttons.filter(button => button.props.title === 'Drop')).toHaveLength(1)
})
