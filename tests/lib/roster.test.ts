import { describe, expect, it, vi } from 'vitest'
import { isDTD, isIREligible } from '@/lib/roster'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))

describe('isIREligible', () => {
    it('returns true for "IR-LTI"', () => expect(isIREligible('IR-LTI')).toBe(true))
    it('returns true for "ir-out"', () => expect(isIREligible('ir-out')).toBe(true))
    it('returns false for "active"', () => expect(isIREligible('active')).toBe(false))
    it('returns false for empty string', () => expect(isIREligible('')).toBe(false))
    it('returns false for null', () => expect(isIREligible(null)).toBe(false))
})

// ── isDTD ──────────────────────────────────────────────────────────────────────

describe('isDTD', () => {
    it('returns true for "DTD"', () => expect(isDTD('DTD')).toBe(true))
    it('returns false for "out"', () => expect(isDTD('out')).toBe(false))
    it('returns false for "IR-LTI"', () => expect(isDTD('IR-LTI')).toBe(false))
    it('returns false for null', () => expect(isDTD(null)).toBe(false))
    it('returns false for empty string', () => expect(isDTD('')).toBe(false))
})
