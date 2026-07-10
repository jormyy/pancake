"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSeasonWeekNumber = resolveSeasonWeekNumber;
function resolveSeasonWeekNumber(weeks, dateISO, mode) {
    const orderedWeeks = [...weeks].sort((left, right) => left.week_number - right.week_number);
    const exactWeek = orderedWeeks.find((week) => week.week_start <= dateISO && week.week_end >= dateISO);
    if (exactWeek || mode === 'exact')
        return exactWeek?.week_number ?? null;
    if (mode === 'current-or-next') {
        const nextWeek = orderedWeeks.find((week) => week.week_end >= dateISO);
        return nextWeek?.week_number ?? orderedWeeks.at(-1)?.week_number ?? null;
    }
    for (let index = orderedWeeks.length - 1; index >= 0; index--) {
        const week = orderedWeeks[index];
        if (week.week_start <= dateISO)
            return week.week_number;
    }
    return null;
}
