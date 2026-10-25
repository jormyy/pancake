import { expect, it } from 'vitest'
import { draftYear, pickLabel } from '@/lib/picks'

it('labels a fantasy season with the prior summer NBA draft year', () => {
    expect([2028, 2029, 2030].map(draftYear)).toEqual([2027, 2028, 2029])
    expect(pickLabel(2028, 1)).toBe('2027 Round 1')
    expect(pickLabel(2030, 3)).toBe('2029 Round 3')
})
