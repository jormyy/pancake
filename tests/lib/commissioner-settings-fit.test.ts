import { expect, it } from 'vitest'
import { playoffFit } from '@/lib/commissioner-settings-draft'

it('fits the final saved week and rejects one week beyond it', () => {
    const weeks = Array.from({ length: 24 }, (_, index) => index + 1)
    expect(playoffFit(weeks, 20, [1, 2, 2])).toEqual({ status: 'fit', lastAvailableWeek: 24, requiredWeeks: 5, endWeek: 24 })
    expect(playoffFit(weeks, 21, [1, 2, 2]).status).toBe('does-not-fit')
    expect(playoffFit(weeks.filter(week => week !== 17), 20, [1, 2, 2]).status).toBe('does-not-fit')
    expect(playoffFit([], 20, [1, 2, 2]).status).toBe('calendar-unpublished')
    expect(playoffFit(weeks, 20, [0, 1]).status).toBe('invalid-settings')
})
