"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seasonYearForGameDate = seasonYearForGameDate;
exports.normalizedScheduleTimestamp = normalizedScheduleTimestamp;
exports.etDateKey = etDateKey;
exports.seasonEndYearFromScheduleLabel = seasonEndYearFromScheduleLabel;
exports.assertScheduleFresh = assertScheduleFresh;
exports.buildSeasonWeekRows = buildSeasonWeekRows;
exports.buildScheduleSyncPlan = buildScheduleSyncPlan;
const gameId_1 = require("./gameId");
function seasonYearForGameDate(gameDate) {
    const [yearText, monthText] = gameDate.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
        throw new Error(`Could not derive season year from game date: ${gameDate}`);
    }
    return month >= 10 ? year + 1 : year;
}
function normalizedScheduleTimestamp(value) {
    if (!value)
        return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return null;
    return date.toISOString();
}
function etDateKey(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}
function seasonEndYearFromScheduleLabel(label) {
    const match = label?.match(/^(\d{4})-(\d{2}|\d{4})$/);
    if (!match)
        return null;
    const startYear = Number(match[1]);
    const endText = match[2];
    if (endText.length === 4)
        return Number(endText);
    const century = Math.floor(startYear / 100) * 100;
    const sameCenturyEnd = century + Number(endText);
    return sameCenturyEnd <= startYear ? sameCenturyEnd + 100 : sameCenturyEnd;
}
function assertScheduleFresh(regularSeason, seasonYear, now = new Date()) {
    const sourceSeasonYear = seasonEndYearFromScheduleLabel(regularSeason[0]?.scheduleSeasonYear);
    if (sourceSeasonYear != null && sourceSeasonYear !== seasonYear) {
        throw new Error(`NBA schedule season label ${regularSeason[0]?.scheduleSeasonYear} does not match game dates for season ${seasonYear}`);
    }
    const dates = regularSeason.map((game) => game.gameDate).sort();
    const latestGameDate = dates[dates.length - 1];
    const today = etDateKey(now);
    if (latestGameDate && latestGameDate < today) {
        throw new Error(`NBA schedule payload is stale; latest regular-season game ${latestGameDate} is before ${today}`);
    }
}
function buildSeasonWeekRows(games, seasonYear) {
    const weekMap = {};
    for (const game of games) {
        if (!game.week_number)
            continue;
        const existing = weekMap[game.week_number];
        if (!existing) {
            weekMap[game.week_number] = { start: game.game_date, end: game.game_date };
            continue;
        }
        if (game.game_date < existing.start)
            existing.start = game.game_date;
        if (game.game_date > existing.end)
            existing.end = game.game_date;
    }
    return Object.entries(weekMap).map(([weekNumber, range]) => ({
        season_year: seasonYear,
        week_number: parseInt(weekNumber),
        week_start: range.start,
        week_end: range.end,
    }));
}
function buildScheduleSyncPlan(raw, now = new Date()) {
    const regularSeason = raw.filter((game) => (0, gameId_1.isRegularSeasonGameId)(game.gameId));
    const dateCounts = new Map();
    for (const game of regularSeason) {
        dateCounts.set(game.gameDate, (dateCounts.get(game.gameDate) ?? 0) + 1);
    }
    const bulkStartDates = [...dateCounts.entries()]
        .filter(([, count]) => count >= 5)
        .map(([date]) => date)
        .sort();
    const seasonStart = bulkStartDates[0] ?? regularSeason.map((game) => game.gameDate).sort()[0] ?? null;
    if (!seasonStart) {
        return { regularSeason, seasonStart: null, seasonYear: null, rows: [], weeks: [] };
    }
    const seasonYear = seasonYearForGameDate(seasonStart);
    assertScheduleFresh(regularSeason, seasonYear, now);
    const updatedAt = now.toISOString();
    const rows = regularSeason
        .filter((game) => game.homeTeam && game.awayTeam)
        .map((game) => ({
        nba_game_id: game.gameId,
        season_year: seasonYear,
        game_date: game.gameDate,
        home_team: game.homeTeam,
        away_team: game.awayTeam,
        status: game.status,
        started_at: normalizedScheduleTimestamp(game.startedAt),
        game_time: normalizedScheduleTimestamp(game.startedAt),
        ended_at: null,
        week_number: game.weekNumber ?? 0,
        updated_at: updatedAt,
    }));
    return {
        regularSeason,
        seasonStart,
        seasonYear,
        rows,
        weeks: buildSeasonWeekRows(rows, seasonYear),
    };
}
