import { palette } from './tokens'

// Position identity colors — vivid + distinct for fast scanning. Sourced from
// the single palette so there is no parallel color list.
export const POSITION_COLORS: Record<string, string> = {
    PG: palette.red500,    // red
    SG: palette.orange,    // orange
    SF: palette.green500,  // green
    PF: palette.blue500,   // blue
    C:  palette.purple500, // purple
    G:  palette.orangeFlex, // light orange (guard flex)
    F:  palette.greenLight, // light green (forward flex)
}

export function getPositionColor(pos: string | null | undefined, fallback: string = palette.gray500): string {
    return (pos && POSITION_COLORS[pos]) ? POSITION_COLORS[pos] : fallback
}
