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

export function sameRosterLimits(expected: RosterLimits | null, current: RosterLimits | null): boolean {
    return !!expected && !!current && expected.rosterSize === current.rosterSize
        && expected.irSlots === current.irSlots && expected.taxiSlots === current.taxiSlots
}

export function staleRosterLimitsNotice(current: RosterLimits | null): { title: string; message: string } {
    return current
        ? { title: 'Roster settings changed', message: 'League roster settings changed. Try again.' }
        : { title: 'Roster settings loading', message: 'League roster settings are still loading. Try again in a moment.' }
}

export type RookiePlacement = 'active' | 'taxi' | 'drop'

export type RookiePlacementPlan = {
    activeAfter: number
    taxiAfter: number
    activeOver: number
    taxiOver: number
    dropChoices: 'active' | 'taxi' | null
    valid: boolean
}

export function planRookiePlacement<T extends RosterRow & { id: string }>(
    roster: readonly T[],
    limits: RosterLimits,
    placement: RookiePlacement,
    dropIds: readonly string[],
): RookiePlacementPlan {
    const drops = new Set(dropIds)
    const kept = partitionRoster(roster.filter(row => !drops.has(row.id)))
    const before = partitionRoster(roster)
    const activeAfter = kept.active.length + (placement === 'active' ? 1 : 0)
    const taxiAfter = kept.taxi.length + (placement === 'taxi' ? 1 : 0)
    const activeOver = Math.max(0, activeAfter - limits.rosterSize)
    const taxiOver = Math.max(0, taxiAfter - limits.taxiSlots)
    const activeFull = before.active.length + 1 > limits.rosterSize
    const taxiFull = before.taxi.length + 1 > limits.taxiSlots
    const dropChoices = placement === 'active' && activeFull ? 'active' : placement === 'taxi' && taxiFull ? 'taxi' : null
    return { activeAfter, taxiAfter, activeOver, taxiOver, dropChoices, valid: activeOver === 0 && taxiOver === 0 }
}
