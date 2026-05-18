export function toETDate(date: Date): string {
    return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export function todayET(): string {
    return toETDate(new Date())
}

export function tomorrowET(): string {
    const today = todayET()
    const [y, m, d] = today.split('-').map(Number)
    const next = new Date(Date.UTC(y, m - 1, d + 1))
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}
