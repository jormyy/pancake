import { describe, expect, it } from 'vitest'
import { orderTradeAssets } from '@/lib/trade-assets'

describe('trade asset display order', () => {
    const assets = [
        { id: 'r1-2030', kind: 'pick', round: 1, seasonYear: 2029 },
        { id: 'r1-2029', kind: 'pick', round: 1, seasonYear: 2028 },
        { id: 'r2-2031', kind: 'pick', round: 2, seasonYear: 2030 },
        { id: 'aaron', kind: 'player' },
        { id: 'r1-2031', kind: 'pick', round: 1, seasonYear: 2030 },
        { id: 'r2-2030', kind: 'pick', round: 2, seasonYear: 2029 },
        { id: 'pj', kind: 'player' },
        { id: 'r1-2029-tie', kind: 'pick', round: 1, seasonYear: 2028 },
        { id: 'faab', kind: 'faab' },
    ]

    it('keeps players before picks sorted by round and year with stable ties', () => {
        expect(orderTradeAssets(assets).map(asset => asset.id)).toEqual([
            'aaron', 'pj', 'r1-2029', 'r1-2029-tie', 'r1-2030', 'r1-2031', 'r2-2030', 'r2-2031', 'faab',
        ])
    })

    it('orders dynasty values descending, then names and ids, with missing values last', () => {
        const players = [
            { kind: 'player', playerId: 'missing-b', playerName: 'Beta', tradeValue: null },
            { kind: 'player', playerId: 'low', playerName: 'Low', tradeValue: 100 },
            { kind: 'player', playerId: 'tie-b', playerName: 'Alpha', tradeValue: 800 },
            { kind: 'player', playerId: 'high', playerName: 'High', tradeValue: 900 },
            { kind: 'player', playerId: 'tie-a', playerName: 'Alpha', tradeValue: 800 },
            { kind: 'player', playerId: 'zero', playerName: 'Zero', tradeValue: 0 },
            { kind: 'player', playerId: 'missing-a', playerName: 'Alpha' },
            { kind: 'player', playerId: 'invalid', playerName: 'Invalid', tradeValue: NaN },
        ]
        const expected = ['high', 'tie-a', 'tie-b', 'low', 'zero', 'missing-a', 'missing-b', 'invalid']
        expect(orderTradeAssets(players).map(player => player.playerId)).toEqual(expected)
        expect(orderTradeAssets([...players].reverse()).map(player => player.playerId)).toEqual(expected)
    })

    it.each(['direct', 'wrapped'])('opts %s assets into year-first picks without changing player order or inputs', shape => {
        const items = Object.freeze([
            { kind: 'pick', playerId: '2028-r1', seasonYear: 2028, round: 1 },
            { kind: 'player', playerId: 'low', playerName: 'Low', tradeValue: 100 },
            { kind: 'pick', playerId: '2027-r2', seasonYear: 2027, round: 2 },
            { kind: 'player', playerId: 'tie-b', playerName: 'Alpha', tradeValue: 800 },
            { kind: 'pick', playerId: '2029-r1', seasonYear: 2029, round: 1 },
            { kind: 'player', playerId: 'high', playerName: 'High', tradeValue: 900 },
            { kind: 'pick', playerId: '2027-r1', seasonYear: 2027, round: 1 },
            { kind: 'player', playerId: 'tie-a', playerName: 'Alpha', tradeValue: 800 },
        ].map(item => Object.freeze(item)))
        const before = structuredClone(items)
        const ordered = shape === 'direct' ? orderTradeAssets(items, 'year-round')
            : orderTradeAssets(items.map(asset => ({ asset })), item => item.asset, 'year-round').map(item => item.asset)
        expect(ordered.map(item => item.playerId)).toEqual(['high', 'tie-a', 'tie-b', 'low', '2027-r1', '2027-r2', '2028-r1', '2029-r1'])
        expect(items).toEqual(before)
        expect(ordered.every(item => items.includes(item))).toBe(true)
    })

    it('does not change the array or its assets', () => {
        const frozen = Object.freeze(assets.map(asset => Object.freeze({ ...asset })))
        const before = structuredClone(frozen)
        const ordered = orderTradeAssets(frozen)
        expect(frozen).toEqual(before)
        expect(ordered).not.toBe(frozen)
        expect(ordered.every(asset => frozen.includes(asset))).toBe(true)
    })

    it('orders wrapped display assets without changing their values or routes', () => {
        const wrapped = assets.map(asset => ({ asset, value: 42, recipient: 'team' }))
        expect(orderTradeAssets(wrapped, item => item.asset).map(item => item.asset.id))
            .toEqual(orderTradeAssets(assets).map(asset => asset.id))
        expect(wrapped.every(item => item.value === 42 && item.recipient === 'team')).toBe(true)
    })
})
