export function calculateWeekNumberFromDate(
    dateStr: string,
    week1StartStr: string,
    week1EndStr: string,
): number {
    const date = new Date(dateStr + 'T00:00:00')
    const week1Start = new Date(week1StartStr + 'T00:00:00')
    const week1End = new Date(week1EndStr + 'T23:59:59')

    if (date >= week1Start && date <= week1End) {
        return 1
    }

    const week2Start = new Date(week1EndStr + 'T00:00:00')
    week2Start.setDate(week2Start.getDate() + 1)
    const msPerWeek = 7 * 24 * 60 * 60 * 1000
    const weeksSinceWeek2 = Math.floor((date.getTime() - week2Start.getTime()) / msPerWeek)
    const weekNumber = weeksSinceWeek2 + 2

    return Math.max(1, weekNumber)
}
