import { canPlayLineupSlot, LINEUP_SLOT_ALLOWED_POSITIONS } from '@pancake/core'

export const SLOT_ELIGIBLE: Record<string, readonly string[]> = LINEUP_SLOT_ALLOWED_POSITIONS

export function canPlaySlot(positions: string[] | null | undefined, slotType: string): boolean {
    return canPlayLineupSlot(null, positions ?? [], slotType)
}
