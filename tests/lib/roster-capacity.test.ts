import { describe, expect, it } from 'vitest'
import { partitionRoster, rosterLimits, rosterLocation } from '@/lib/roster-capacity'

type Row = { id: string; is_on_ir: boolean; is_on_taxi: boolean }

const row = (id: string, location: 'active' | 'ir' | 'taxi'): Row => ({
    id,
    is_on_ir: location === 'ir',
    is_on_taxi: location === 'taxi',
})

describe('roster capacity', () => {
    it('partitions 18 active, 2 taxi, and 1 IR row and reports the open slots', () => {
        const roster = [
            ...Array.from({ length: 18 }, (_, index) => row(`active-${index}`, 'active')),
            ...Array.from({ length: 2 }, (_, index) => row(`taxi-${index}`, 'taxi')),
            row('ir-0', 'ir'),
        ]

        const { active, ir, taxi } = partitionRoster(roster)
        const limits = rosterLimits({ roster_size: 20, ir_slots: 2, taxi_slots: 2 })

        expect(active).toHaveLength(18)
        expect(ir).toHaveLength(1)
        expect(taxi).toHaveLength(2)
        expect(limits).toEqual({ rosterSize: 20, irSlots: 2, taxiSlots: 2 })
        expect(active.length < limits!.rosterSize).toBe(true)
        expect(limits!.irSlots - ir.length).toBe(1)
        expect(limits!.taxiSlots - taxi.length).toBe(0)
    })

    it('has no limits without a current league', () => {
        expect(rosterLimits(null)).toBeNull()
        expect(rosterLimits(undefined)).toBeNull()
    })

    it('has no limits when a cached league is missing a limit column', () => {
        expect(rosterLimits({ roster_size: 20, ir_slots: 2 })).toBeNull()
    })

    it('places every row in exactly one location', () => {
        expect(rosterLocation({ is_on_ir: false, is_on_taxi: false })).toBe('active')
        expect(rosterLocation({ is_on_ir: true, is_on_taxi: false })).toBe('ir')
        expect(rosterLocation({ is_on_ir: false, is_on_taxi: true })).toBe('taxi')
    })
})
