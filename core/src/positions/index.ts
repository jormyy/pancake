export const SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR'] as const
export type SlotType = (typeof SLOT_TYPES)[number]
export const LINEUP_SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE'] as const
export type LineupSlotType = (typeof LINEUP_SLOT_TYPES)[number]

export const LINEUP_SLOT_ALLOWED_POSITIONS: Record<LineupSlotType, readonly string[]> = {
    PG: ['PG'],
    SG: ['SG'],
    SF: ['SF'],
    PF: ['PF'],
    C: ['C'],
    G: ['PG', 'SG'],
    F: ['SF', 'PF'],
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
    if (!(slotType in LINEUP_SLOT_ALLOWED_POSITIONS)) return false

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

export function canPlaySlot(
    position: string | null,
    eligiblePositions: readonly string[],
    slotType: SlotType,
): boolean {
    return canOccupyRosterSlot(position, eligiblePositions, slotType)
}
