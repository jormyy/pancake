"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateFantasyPoints = calculateFantasyPoints;
exports.roundFantasyPoints = roundFantasyPoints;
exports.snakeToStatLine = snakeToStatLine;
function calculateFantasyPoints(stats, settings) {
    if (stats.didNotPlay)
        return 0;
    return roundFantasyPoints(stats.points * (settings.points ?? 0) +
        stats.rebounds * (settings.rebounds ?? 0) +
        stats.assists * (settings.assists ?? 0) +
        stats.steals * (settings.steals ?? 0) +
        stats.blocks * (settings.blocks ?? 0) +
        stats.turnovers * (settings.turnovers ?? 0) +
        stats.threePointersMade * (settings.three_pointers_made ?? 0) +
        stats.fieldGoalsMade * (settings.field_goals_made ?? 0) +
        stats.fieldGoalsAttempted * (settings.field_goals_attempted ?? 0) +
        stats.freeThrowsMade * (settings.free_throws_made ?? 0) +
        stats.freeThrowsAttempted * (settings.free_throws_attempted ?? 0) +
        (stats.doubleDouble ? (settings.double_double ?? 0) : 0) +
        (stats.tripleDouble ? (settings.triple_double ?? 0) : 0));
}
function roundFantasyPoints(value) {
    const sign = Math.sign(value) || 1;
    const [coefficient, exponent = '0'] = Math.abs(value).toString().split('e');
    const shifted = Number(`${coefficient}e${Number(exponent) + 2}`);
    return sign * Number(`${Math.round(shifted)}e-2`);
}
/**
 * Convert a snake_case stat row (as stored in the DB) into a camelCase StatLine.
 * Missing or null fields default to 0 / false so callers don't need to guard.
 */
function snakeToStatLine(row) {
    return {
        points: row.points ?? 0,
        rebounds: row.rebounds ?? 0,
        assists: row.assists ?? 0,
        steals: row.steals ?? 0,
        blocks: row.blocks ?? 0,
        turnovers: row.turnovers ?? 0,
        threePointersMade: row.three_pointers_made ?? 0,
        fieldGoalsMade: row.field_goals_made ?? 0,
        fieldGoalsAttempted: row.field_goals_attempted ?? 0,
        freeThrowsMade: row.free_throws_made ?? 0,
        freeThrowsAttempted: row.free_throws_attempted ?? 0,
        doubleDouble: row.double_double ?? false,
        tripleDouble: row.triple_double ?? false,
        didNotPlay: row.did_not_play ?? false,
    };
}
