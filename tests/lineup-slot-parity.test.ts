import { describe, expect, it } from 'vitest'
import { LINEUP_SLOT_ALLOWED_POSITIONS, canPlayLineupSlot } from '@pancake/core'
import { readFunctionSource } from './source-guard'

function sqlLineupSlots(source: string): Record<string, string[]> {
    const slots: Record<string, string[]> = {}
    const branches = /WHEN '([^']+)'::roster_slot_type THEN ARRAY\[([^\]]*)\]::text\[\]/g
    for (const match of source.matchAll(branches)) {
        slots[match[1]] = [...match[2].matchAll(/'([^']+)'/g)].map((value) => value[1])
    }
    return slots
}

describe('lineup slot eligibility parity', () => {
    it('keeps core lineup slots aligned with the database helper', () => {
        const sql = readFunctionSource('lineup_slot_allowed_positions')

        expect(sqlLineupSlots(sql)).toEqual(LINEUP_SLOT_ALLOWED_POSITIONS)
        expect(sql).toContain("ELSE '{}'::text[]")
        expect(LINEUP_SLOT_ALLOWED_POSITIONS).not.toHaveProperty('IR')
        expect(canPlayLineupSlot('PG', ['PG'], 'IR')).toBe(false)
    })
})
