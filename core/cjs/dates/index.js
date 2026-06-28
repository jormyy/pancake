"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.todayDateString = todayDateString;
exports.toETDate = toETDate;
exports.todayET = todayET;
exports.endOfETDayUTC = endOfETDayUTC;
function todayDateString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function toETDate(date) {
    return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function todayET() {
    return toETDate(new Date());
}
function newYorkOffsetMinutes(utcDate) {
    const offsetPart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'longOffset',
    }).formatToParts(utcDate).find((part) => part.type === 'timeZoneName')?.value;
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
