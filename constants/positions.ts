import { palette } from './tokens'

// Position identity colors — warm-leaning, saturation-matched deep hues that
// sit naturally against the cream/maple brand while staying clearly distinct
// from each other. Sourced from the single palette so there is no parallel
// color list. Every hue keeps white chip text >=4.5:1 (WCAG AA).
export const POSITION_COLORS: Record<string, string> = {
    PG: palette.posCoral,  // deep coral
    SG: palette.posBurnt,  // burnt orange
    SF: palette.posForest, // forest green
    PF: palette.posTeal,   // teal-slate
    C:  palette.posPlum,   // plum
    G:  palette.posAmber,  // deep amber (guard flex)
    F:  palette.posSage,   // sage (forward flex)
}

export function getPositionColor(pos: string | null | undefined, fallback: string = palette.gray500): string {
    return (pos && POSITION_COLORS[pos]) ? POSITION_COLORS[pos] : fallback
}
