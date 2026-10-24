import { canPlayLineupSlot } from '@pancake/core'

export function canPlaySlot(positions: string[] | null | undefined, slotType: string): boolean {
    return canPlayLineupSlot(null, positions ?? [], slotType)
}
