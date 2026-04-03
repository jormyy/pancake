/** Which player positions are eligible for each slot type */
export const SLOT_ELIGIBLE: Record<string, string[]> = {
    PG: ['PG'],
    SG: ['SG'],
    SF: ['SF'],
    PF: ['PF'],
    C: ['C'],
    G: ['PG', 'SG'],
    F: ['SF', 'PF'],
    UTIL: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
    BE: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
}

export function canPlaySlot(positions: string[] | null | undefined, slotType: string): boolean {
    if (!positions?.length || slotType === 'IR') return false
    const eligible = SLOT_ELIGIBLE[slotType]
    if (!eligible) return false
    return positions.some((p) => eligible.includes(p))
}
