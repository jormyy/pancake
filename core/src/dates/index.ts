export function todayDateString(): string {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

export function toETDate(date: Date): string {
    return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export function todayET(): string {
    return toETDate(new Date())
}

function newYorkOffsetMinutes(utcDate: Date): number {
    const offsetPart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'longOffset',
    }).formatToParts(utcDate).find((part) => part.type === 'timeZoneName')?.value
    const match = offsetPart?.match(/^GMT([+-])(\d{2}):?(\d{2})?$/)
    if (!match) return -300
    const sign = match[1] === '-' ? -1 : 1
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0))
}

export function endOfETDayUTC(etDate: string): string {
    const [year, month, day] = etDate.split('-').map(Number)
    const nextLocalMidnightAsUTC = Date.UTC(year, month - 1, day + 1, 0, 0, 0)
    let utcTime = nextLocalMidnightAsUTC + 5 * 60 * 60 * 1000

    for (let i = 0; i < 2; i += 1) {
        utcTime = nextLocalMidnightAsUTC - newYorkOffsetMinutes(new Date(utcTime)) * 60 * 1000
    }

    return new Date(utcTime).toISOString()
}
