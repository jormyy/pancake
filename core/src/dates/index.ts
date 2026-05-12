export function todayDateString(): string {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

export function todayET(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
