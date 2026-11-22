export type RosterLocation = 'active' | 'ir' | 'taxi'

export type RosterRow = {
    is_on_ir: boolean
    is_on_taxi: boolean
}

export type RosterLimits = {
    rosterSize: number
    irSlots: number
    taxiSlots: number
}

export type LeagueRosterLimits = {
    roster_size?: number
    ir_slots?: number
    taxi_slots?: number
}

export function rosterLocation(row: RosterRow): RosterLocation {
    if (row.is_on_taxi) return 'taxi'
    if (row.is_on_ir) return 'ir'
    return 'active'
}

export function partitionRoster<T extends RosterRow>(roster: readonly T[]): { active: T[]; ir: T[]; taxi: T[] } {
    const active: T[] = []
    const ir: T[] = []
    const taxi: T[] = []
    for (const row of roster) {
        const location = rosterLocation(row)
        if (location === 'taxi') taxi.push(row)
        else if (location === 'ir') ir.push(row)
        else active.push(row)
    }
    return { active, ir, taxi }
}

export function rosterLimits(league: LeagueRosterLimits | null | undefined): RosterLimits | null {
    if (!league) return null
    const { roster_size: rosterSize, ir_slots: irSlots, taxi_slots: taxiSlots } = league
    if (typeof rosterSize !== 'number' || typeof irSlots !== 'number' || typeof taxiSlots !== 'number') return null
    return { rosterSize, irSlots, taxiSlots }
}

