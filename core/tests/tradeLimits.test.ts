import { describe, expect, it } from 'vitest'
import {
    MAX_TRADE_EXPIRATION_DAYS,
    MAX_TRADE_FAAB_AMOUNT,
    MAX_TRADE_ITEMS,
    MAX_TRADE_NOTES_BYTES,
    MAX_TRADE_PARTICIPANTS,
    utf8ByteLength,
} from '../src'

describe('trade limits', () => {
    it('exports canonical trade bounds', () => {
        expect(MAX_TRADE_ITEMS).toBe(100)
        expect(MAX_TRADE_EXPIRATION_DAYS).toBe(30)
        expect(MAX_TRADE_FAAB_AMOUNT).toBe(1_000_000)
        expect(MAX_TRADE_NOTES_BYTES).toBe(2_000)
        expect(MAX_TRADE_PARTICIPANTS).toBe(12)
    })

    it.each([
        ['ASCII boundary', 'n'.repeat(2_000), 2_000],
        ['accented boundary', 'é'.repeat(1_000), 2_000],
        ['accented overflow', 'é'.repeat(1_001), 2_002],
        ['emoji boundary', '😀'.repeat(500), 2_000],
        ['emoji overflow', '😀'.repeat(501), 2_004],
    ])('counts UTF-8 bytes for %s', (_label, value, expected) => {
        expect(utf8ByteLength(value)).toBe(expected)
    })
})
