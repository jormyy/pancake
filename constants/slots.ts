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

export function canPlaySlot(position: string | null, slotType: string): boolean {
    if (!position || slotType === 'IR') return false
    return SLOT_ELIGIBLE[slotType]?.includes(position) ?? false
}
