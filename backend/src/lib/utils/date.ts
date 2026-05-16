export function toETDate(date: Date): string {
    return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export function todayET(): string {
    return toETDate(new Date())
}

export function tomorrowET(): string {
    return toETDate(new Date(Date.now() + 24 * 60 * 60 * 1000))
}
