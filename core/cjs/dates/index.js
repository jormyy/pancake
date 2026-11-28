"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toETDate = toETDate;
exports.todayET = todayET;
exports.endOfETDayUTC = endOfETDayUTC;
const etDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function toETDate(date) {
    return etDateFormatter.format(date);
}
function todayET() {
    return toETDate(new Date());
}
const nyOffsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
});
function newYorkOffsetMinutes(utcDate) {
    const offsetPart = nyOffsetFormatter.formatToParts(utcDate).find((part) => part.type === 'timeZoneName')?.value;
    const match = offsetPart?.match(/^GMT([+-])(\d{2}):?(\d{2})?$/);
    if (!match)
        return -300;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}
function endOfETDayUTC(etDate) {
    const [year, month, day] = etDate.split('-').map(Number);
    const nextLocalMidnightAsUTC = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
    let utcTime = nextLocalMidnightAsUTC + 5 * 60 * 60 * 1000;
    for (let i = 0; i < 2; i += 1) {
        utcTime = nextLocalMidnightAsUTC - newYorkOffsetMinutes(new Date(utcTime)) * 60 * 1000;
    }
    return new Date(utcTime).toISOString();
}
