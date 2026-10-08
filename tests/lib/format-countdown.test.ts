import { describe, expect, it, vi } from 'vitest'

// lib/format reads API_URL, whose module pulls in react-native.
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))

import { formatCountdown } from '@/lib/format'

describe('formatCountdown', () => {
    it('shows minutes and seconds under an hour', () => {
        expect(formatCountdown(5)).toBe('0:05')
        expect(formatCountdown(75)).toBe('1:15')
        expect(formatCountdown(3599)).toBe('59:59')
    })

    it('shows hours for slow draft clocks so the text fits the clock', () => {
        expect(formatCountdown(3600)).toBe('1h')
        expect(formatCountdown(3900)).toBe('1h 5m')
        expect(formatCountdown(101466)).toBe('28h')
    })

    it('never shows a negative clock', () => {
        expect(formatCountdown(-3)).toBe('0:00')
    })
})
