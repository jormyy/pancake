import { describe, expect, it } from 'vitest'
import { MAX_TRADE_EXPIRATION_DAYS, MAX_TRADE_ITEMS } from '../src'

describe('trade limits', () => {
    it('exports canonical item and expiration bounds', () => {
        expect(MAX_TRADE_ITEMS).toBe(100)
        expect(MAX_TRADE_EXPIRATION_DAYS).toBe(30)
    })
})
