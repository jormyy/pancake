import { describe, expect, it } from 'vitest'
import { MAX_TRADE_EXPIRATION_DAYS, MAX_TRADE_ITEMS, MAX_TRADE_NOTES_LENGTH } from '../src'

describe('trade limits', () => {
    it('exports canonical trade bounds', () => {
        expect(MAX_TRADE_ITEMS).toBe(100)
        expect(MAX_TRADE_EXPIRATION_DAYS).toBe(30)
        expect(MAX_TRADE_NOTES_LENGTH).toBe(2_000)
    })
})
