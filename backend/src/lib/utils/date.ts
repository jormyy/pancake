export function todayET(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export function tomorrowET(): string {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
    })
}
