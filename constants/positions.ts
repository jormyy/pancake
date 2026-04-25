export const POSITION_COLORS: Record<string, string> = {
    PG: '#EF4444', // red
    SG: '#F97316', // orange
    SF: '#10B981', // green
    PF: '#3B82F6', // blue
    C:  '#8B5CF6', // purple
    G:  '#FB923C', // light orange (guard flex)
    F:  '#34D399', // light green (forward flex)
}

export function getPositionColor(pos: string | null | undefined, fallback = '#ccc'): string {
    return (pos && POSITION_COLORS[pos]) ? POSITION_COLORS[pos] : fallback
}
