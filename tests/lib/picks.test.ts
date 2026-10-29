import { expect, it } from 'vitest'
import { draftYear, pickLabel } from '@/lib/picks'

it('labels picks with their stored year', () => {
    expect([2028, 2029, 2030].map(draftYear)).toEqual([2028, 2029, 2030])
    expect(pickLabel(2028, 1)).toBe('2028 Round 1')
    expect(pickLabel(2030, 3)).toBe('2030 Round 3')
})
