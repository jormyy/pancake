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

    it('keeps players in order, then sorts picks by round and year with stable ties', () => {
        expect(orderTradeAssets(assets).map(asset => asset.id)).toEqual([
            'aaron', 'pj', 'r1-2029', 'r1-2029-tie', 'r1-2030', 'r1-2031', 'r2-2030', 'r2-2031', 'faab',
        ])
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
