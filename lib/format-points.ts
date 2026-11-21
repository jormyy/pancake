/** Fantasy points as a whole number, em-dash when absent: 12.6 → "13", null → "—" */
export function formatPoints(value: number | null | undefined): string {
    return value == null ? '—' : String(Math.round(value) || 0)
}

/** Real stats (minutes, rebounds…) to one decimal, em-dash when absent: 32.4 → "32.4" */
export function formatStat(value: number | null | undefined): string {
    return value == null ? '—' : value.toFixed(1)
}
