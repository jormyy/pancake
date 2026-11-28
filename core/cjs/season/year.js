"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.currentSeasonYear = currentSeasonYear;
const zonedFormatters = new Map();
function zonedParts(date, timeZone) {
    let formatter = zonedFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' });
        zonedFormatters.set(timeZone, formatter);
    }
    const [monthText, yearText] = formatter.format(date).split('/');
    const year = Number(yearText);
    const month = Number(monthText);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
        throw new Error(`Could not resolve season year in ${timeZone}`);
    }
    return { year, month };
}
function currentSeasonYear(now = new Date(), timeZone = 'America/New_York') {
    const { year, month } = zonedParts(now, timeZone);
    return month >= 10 ? year + 1 : year;
}
