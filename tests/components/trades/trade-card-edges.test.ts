import { expect, it } from 'vitest'
import { tradeCardEdges, type TradeListItem } from '@/lib/trades-screen-model'

const trade = (id: string): TradeListItem => ({ _type: 'trade', trade: { id } as never })
const header = (label: string): TradeListItem => ({ _type: 'header', label })

it('gives every headerless history trade its own card and gap', () => {
    expect(tradeCardEdges([trade('a'), trade('b'), trade('c')])).toEqual({
        first: [true, true, true],
        last: [true, true, true],
    })
})

it('keeps a section band and its trades in one card', () => {
    const items = [header('Incoming'), trade('a'), trade('b'), header('Outgoing'), trade('c')]
    expect(tradeCardEdges(items)).toEqual({
        first: [true, false, false, true, false],
        last: [false, false, true, false, true],
    })
})

it('closes a band-only section before the next band', () => {
    const items = [header('League listings'), header('Your listings'), trade('a')]
    expect(tradeCardEdges(items)).toEqual({
        first: [true, true, false],
        last: [true, false, true],
    })
})

it('has no edges for an empty list', () => {
    expect(tradeCardEdges([])).toEqual({ first: [], last: [] })
})
