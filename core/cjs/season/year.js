"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.currentSeasonYear = currentSeasonYear;
function zonedParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
    }).formatToParts(date);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
        throw new Error(`Could not resolve season year in ${timeZone}`);
    }
    return { year, month };
}
function currentSeasonYear(now = new Date(), timeZone = 'America/New_York') {
    const { year, month } = zonedParts(now, timeZone);
    return month >= 10 ? year + 1 : year;
}
