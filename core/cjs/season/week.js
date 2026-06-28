"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateWeekNumberFromDate = calculateWeekNumberFromDate;
function calculateWeekNumberFromDate(dateStr, week1StartStr, week1EndStr) {
    const date = dateOrdinal(dateStr);
    const week1Start = dateOrdinal(week1StartStr);
    const week1End = dateOrdinal(week1EndStr);
    if (date >= week1Start && date <= week1End) {
        return 1;
    }
    const week2Start = week1End + 1;
    const daysPerWeek = 7;
    const weeksSinceWeek2 = Math.floor((date - week2Start) / daysPerWeek);
    const weekNumber = weeksSinceWeek2 + 2;
    return Math.max(1, weekNumber);
}
function dateOrdinal(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
}
