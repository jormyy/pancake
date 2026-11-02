"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveLineStats = liveLineStats;
function liveLineStats(row) {
    if (row.length !== 15 || !/^\d+$/.test(row[0]) || row.slice(1).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2147483647))
        return null;
    if (![0, 1].includes(row[14]))
        return null;
    const doubles = [row[1], row[2], row[3], row[4], row[5]].filter(value => value >= 10).length;
    return { points: row[1], rebounds: row[2], assists: row[3], steals: row[4], blocks: row[5], turnovers: row[6],
        threePointersMade: row[7], fieldGoalsMade: row[8], fieldGoalsAttempted: row[9],
        freeThrowsMade: row[10], freeThrowsAttempted: row[11],
        fouls: row[12], minutesPlayed: row[13], didNotPlay: row[14] === 1,
        doubleDouble: doubles >= 2, tripleDouble: doubles >= 3 };
}
