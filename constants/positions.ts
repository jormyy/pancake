import { palette, positionColors, uiColors } from './tokens'

// Position identity colors, themed for light and dark (see positionColors).
export const POSITION_COLORS: Record<string, string> = positionColors

/** Lineup slot chip color: position colors for starters, red for IR, a neutral tint for bench, taxi, and UTIL. */
export function slotColor(slotType: string): string {
    if (slotType === 'IR') return uiColors.accentDanger
    return POSITION_COLORS[slotType] ?? uiColors.neutralTint
}

export function getPositionColor(pos: string | null | undefined, fallback: string = palette.gray500): string {
    return (pos && POSITION_COLORS[pos]) ? POSITION_COLORS[pos] : fallback
}
