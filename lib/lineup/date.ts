import type { WeekDay } from './read'

export function clampDateToWeek(date: string, days: Pick<WeekDay, 'date'>[]): string {
    if (days.length === 0) return date
    if (date < days[0].date) return days[0].date
    const last = days[days.length - 1].date
    if (date > last) return last
    return date
}
