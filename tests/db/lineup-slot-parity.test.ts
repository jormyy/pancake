import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LINEUP_SLOT_ALLOWED_POSITIONS, canPlayLineupSlot } from '@pancake/core'

const database = process.env.SUPABASE_DB_URL

function databaseSlots(): Record<string, string[]> {
    const rows = execFileSync('psql', [database!, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c',
        "SELECT json_object_agg(slot, public.lineup_slot_allowed_positions(slot::roster_slot_type)) FROM unnest(enum_range(NULL::roster_slot_type)::text[]) slot"], { encoding: 'utf8' })
    return JSON.parse(rows)
}

describe.skipIf(process.env.PANCAKE_LINEUP_SLOT_DB_TESTS !== '1' || !database)('lineup slot eligibility parity', () => {
    it('gives every database slot the same eligible positions as the client rules', () => {
        const slots = databaseSlots()
        const lineupSlots = Object.fromEntries(Object.entries(slots).filter(([, positions]) => positions.length > 0))

        expect(lineupSlots).toEqual(LINEUP_SLOT_ALLOWED_POSITIONS)
        expect(slots.IR).toEqual([])
        expect(canPlayLineupSlot('PG', ['PG'], 'IR')).toBe(false)
    })
})
