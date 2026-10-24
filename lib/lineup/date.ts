import type { WeekDay } from './read'

/**
 * Default day for a week view: today when it falls inside the week, otherwise
 * the nearest edge of the week. Without the clamp, viewing a week that does
 * not contain today (offseason, pre-season, catching up on a past week)
 * selects a date with no lineup rows and every slot renders as an em-dash.
 */
export function clampDateToWeek(date: string, days: Pick<WeekDay, 'date'>[]): string {
    if (days.length === 0) return date
    if (date < days[0].date) return days[0].date
    const last = days[days.length - 1].date
    if (date > last) return last
    return date
}
