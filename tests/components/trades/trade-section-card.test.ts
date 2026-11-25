import '../../helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeCardFrame, TradeEmptyRow, TradeOfferRow, TradeSectionRow } from '@/components/trades/TradeListRow'

const cardProps: Record<string, unknown>[] = []

vi.mock('@/components/trades/PendingTradeRosterPlan', () => ({ PendingTradeRosterPlan: () => null }))
vi.mock('@/components/trades/TradeCard', () => ({
    TradeCard: (props: Record<string, unknown>) => {
        cardProps.push(props)
        return null
    },
}))
vi.mock('@/components/trades/TradeBlockNoteEditor', () => ({ TradeBlockNoteEditor: 'TradeBlockNoteEditor' }))
vi.mock('@/hooks/use-jersey-number', () => ({ useJerseyNumber: () => null }))

let screen: ReactTestRenderer | null = null

afterEach(async () => {
    if (screen) await act(async () => { screen?.unmount() })
    screen = null
    cardProps.length = 0
})

it('keeps a section band and its empty row inside one card', async () => {
    await act(async () => {
        screen = create(React.createElement(TradeCardFrame, { first: true, last: true },
            React.createElement(TradeSectionRow, { item: { _type: 'header', label: 'Incoming' } }),
            React.createElement(TradeEmptyRow, { item: { _type: 'empty', key: 'incoming-offers', message: 'No incoming offers.' } })))
    })
    const card = screen!.root.findByType(TradeCardFrame)
    const texts = card.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(texts).toContain('Incoming')
    expect(texts).toContain('No incoming offers.')
    expect(card.findAllByProps({ accessibilityRole: 'header' })).toHaveLength(1)
})

it('renders a list trade as an embedded row inside the section card', async () => {
    const onAction = () => {}
    await act(async () => {
        screen = create(React.createElement(TradeOfferRow, {
            item: { _type: 'trade', trade: { id: 'trade-1' } },
            myMemberId: 'me',
            tab: 'offers',
            tradeVetoMode: 'member_vote',
            isCommissioner: false,
            acting: false,
            onAccept: onAction,
            onReject: onAction,
            onVeto: onAction,
            onWithdraw: onAction,
            onAnalyze: onAction,
            embedded: true,
        } as never))
    })
    expect(cardProps).toHaveLength(1)
    expect(cardProps[0].embedded).toBe(true)
})

it('keeps a standalone band for the wide grid', async () => {
    await act(async () => {
        screen = create(React.createElement(TradeSectionRow, { item: { _type: 'header', label: 'League listings' }, standalone: true }))
    })
    const texts = screen!.root.findAllByType('Text' as React.ElementType).map(node => node.props.children)
    expect(texts).toContain('League listings')
})
