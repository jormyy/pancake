/** Fantasy points as a whole number, em-dash when absent: 12.6 → "13", null → "—" */
export function formatPoints(value: number | null | undefined): string {
    return value == null ? '—' : String(Math.round(value) || 0)
}

/** Per-game averages and projections of fantasy points to one decimal, em-dash when absent: 24.36 → "24.4" */
export function formatAvgPoints(value: number | null | undefined): string {
    return value == null ? '—' : value.toFixed(1)
}

/** Real stats (minutes, rebounds…) to one decimal, em-dash when absent: 32.4 → "32.4" */
export function formatStat(value: number | null | undefined): string {
    return value == null ? '—' : value.toFixed(1)
}
