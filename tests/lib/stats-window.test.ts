import { describe, expect, it } from 'vitest'
import { statsWindowLabel } from '@/lib/stats-window'

describe('shared actual statistics windows', () => {
    it('labels the inclusive Eastern range and per-game units', () => {
        expect(statsWindowLabel({ days: 7, startDate: '2026-10-28', endDate: '2026-11-03', timeZone: 'America/New_York' }))
            .toBe('2026-10-28 – 2026-11-03 ET · Per game · Includes today')
        expect(statsWindowLabel(null)).toBe('')
    })
})
