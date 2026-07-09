import { describe, expect, it } from 'vitest'
import { LINEUP_SLOT_ALLOWED_POSITIONS, canPlayLineupSlot } from '@pancake/core'
import { readFunctionSource } from './source-guard'

function sqlArray(values: readonly string[]): string {
    return `ARRAY[${values.map((value) => `'${value}'`).join(', ')}]::text[]`
}

describe('lineup slot eligibility parity', () => {
    it('keeps core lineup slots aligned with the database helper', () => {
        const sql = readFunctionSource('lineup_slot_allowed_positions')

        for (const [slotType, allowedPositions] of Object.entries(LINEUP_SLOT_ALLOWED_POSITIONS)) {
            expect(sql).toContain(`WHEN '${slotType}'::roster_slot_type THEN ${sqlArray(allowedPositions)}`)
        }
        expect(sql).toContain("ELSE '{}'::text[]")
        expect(LINEUP_SLOT_ALLOWED_POSITIONS).not.toHaveProperty('IR')
        expect(canPlayLineupSlot('PG', ['PG'], 'IR')).toBe(false)
    })
})
