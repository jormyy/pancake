import { positionColors, uiColors } from './tokens'

/**
 * Lineup slot and position chip color: position identity colors (themed for light and dark) for
 * starters, red for IR, a neutral tint for bench, taxi, and UTIL.
 */
export function slotColor(slotType: string): string {
    if (slotType === 'IR') return uiColors.accentDanger
    return positionColors[slotType] ?? uiColors.neutralTint
}
