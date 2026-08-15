import { ROSTER_SLOT_TYPES, type RosterSlotType } from '../types/enums'

export const SLOT_TYPES = ROSTER_SLOT_TYPES
export type SlotType = RosterSlotType
export type LineupSlotType = Exclude<RosterSlotType, 'IR'>
export const LINEUP_SLOT_TYPES: readonly LineupSlotType[] = ROSTER_SLOT_TYPES.filter((slot) => slot !== 'IR')

export const LINEUP_SLOT_ALLOWED_POSITIONS: Record<LineupSlotType, readonly string[]> = {
    PG: ['PG'],
    SG: ['SG'],
    SF: ['SF'],
    PF: ['PF'],
    C: ['C'],
    G: ['PG', 'SG', 'G'],
    F: ['SF', 'PF', 'F'],
    UTIL: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
    BE: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
} as const

function normalizedPositions(position: string | null, eligiblePositions: readonly string[]): string[] {
    return eligiblePositions.length > 0 ? [...eligiblePositions]
        : position ? [position] : []
}

export function canPlayLineupSlot(
    position: string | null,
    eligiblePositions: readonly string[],
    slotType: string,
): boolean {
    if (!Object.hasOwn(LINEUP_SLOT_ALLOWED_POSITIONS, slotType)) return false

    const allPositions = normalizedPositions(position, eligiblePositions)

    if (allPositions.length === 0) return false

    const allowedPositions = LINEUP_SLOT_ALLOWED_POSITIONS[slotType as LineupSlotType]
    return allPositions.some((position) => allowedPositions.includes(position))
}

export function canOccupyRosterSlot(
    position: string | null,
    eligiblePositions: readonly string[],
    slotType: SlotType,
): boolean {
    if (slotType === 'IR') return true
    return canPlayLineupSlot(position, eligiblePositions, slotType)
}
