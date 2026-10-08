import { palette, positionColors } from './tokens'

// Position identity colors, themed for light and dark (see positionColors).
export const POSITION_COLORS: Record<string, string> = positionColors

export function getPositionColor(pos: string | null | undefined, fallback: string = palette.gray500): string {
    return (pos && POSITION_COLORS[pos]) ? POSITION_COLORS[pos] : fallback
}
