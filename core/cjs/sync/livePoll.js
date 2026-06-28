"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIVE_POLL_LEASE_TTL_SECONDS = exports.LIVE_POLL_LOCK_KEY = void 0;
exports.addDaysToETDate = addDaysToETDate;
exports.dateFromETDate = dateFromETDate;
exports.livePollCandidateDates = livePollCandidateDates;
const dates_1 = require("../dates");
exports.LIVE_POLL_LOCK_KEY = 779001;
exports.LIVE_POLL_LEASE_TTL_SECONDS = 90;
function addDaysToETDate(dateKey, days) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
    return shifted.toISOString().slice(0, 10);
}
function dateFromETDate(dateKey) {
    return new Date(`${dateKey}T12:00:00Z`);
}
function livePollCandidateDates(now = new Date()) {
    const today = (0, dates_1.toETDate)(now);
    return [...new Set([addDaysToETDate(today, -1), today])];
}
