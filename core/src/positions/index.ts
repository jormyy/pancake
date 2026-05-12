export const SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE', 'IR'] as const
export type SlotType = (typeof SLOT_TYPES)[number]

const POSITION_GROUPS: Record<string, string[]> = {
    G: ['PG', 'SG'],
    F: ['SF', 'PF'],
}

export function canPlaySlot(
    position: string | null,
    eligiblePositions: string[],
    slotType: SlotType,
): boolean {
    if (slotType === 'UTIL' || slotType === 'BE' || slotType === 'IR') return true

    const allPositions = eligiblePositions.length > 0 ? eligiblePositions
        : position ? [position] : []

    if (allPositions.length === 0) return false

    const group = POSITION_GROUPS[slotType]
    if (group) return allPositions.some((p) => group.includes(p))

    return allPositions.includes(slotType)
}
