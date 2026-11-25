import '../../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeSectionRow } from '@/components/trades/TradeListRow'

vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/components/trades/TradeCard', () => ({ TradeCard: 'TradeCard' }))
vi.mock('@/components/trades/TradeBlockNoteEditor', () => ({ TradeBlockNoteEditor: 'TradeBlockNoteEditor' }))
vi.mock('@/hooks/use-jersey-number', () => ({ useJerseyNumber: () => null }))

let screen: ReactTestRenderer | null = null

afterEach(async () => {
    if (screen) await act(async () => { screen?.unmount() })
    screen = null
})

it('gives every trade list section a titled band', async () => {
    await act(async () => {
        screen = create(React.createElement(TradeSectionRow, { item: { _type: 'header', label: 'Incoming' } }))
    })
    const labels = screen!.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(labels).toContain('Incoming')
    expect(screen!.root.findAllByProps({ accessibilityRole: 'header' })).toHaveLength(1)
})
