import { describe, expect, it } from 'vitest'
import { STAT_COLUMN_SORT } from '@/lib/player-search-sort'

describe('sort column maps', () => {
    it('maps each desktop table header label to a sort mode', () => {
        expect(STAT_COLUMN_SORT['3PM']).toBe('tpm')
        expect(STAT_COLUMN_SORT.FP).toBe('fpts')
        expect(STAT_COLUMN_SORT.MIN).toBe('min')
        expect(STAT_COLUMN_SORT.GP).toBe('gp')
    })
})
