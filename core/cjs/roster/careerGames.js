"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.careerRegularSeasonGames = careerRegularSeasonGames;
exports.careerFirstSeasonYear = careerFirstSeasonYear;
exports.careerGamesPrior = careerGamesPrior;
function nbaCareer(payload) {
    if (!payload || typeof payload !== 'object')
        return null;
    const source = payload;
    if (!Array.isArray(source.filters) || !source.filters.some(filter => filter?.name === 'league' && filter.value === 'nba'))
        return null;
    if (source.categories !== undefined && !Array.isArray(source.categories))
        return null;
    return source;
}
function gamesIndex(category) {
    const index = Array.isArray(category.names) ? category.names.indexOf('gamesPlayed') : -1;
    return index >= 0 ? index : Array.isArray(category.labels) ? category.labels.indexOf('GP') : -1;
}
function gamesNumber(raw) {
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^\d+$/.test(String(raw)))
        return null;
    const games = Number(raw);
    return Number.isSafeInteger(games) ? games : null;
}
function careerRegularSeasonGames(payload, yearsExp = null) {
    const source = nbaCareer(payload);
    if (!source)
        return null;
    const season = source.filters.find(filter => filter?.name === 'seasontype');
    if (!season && source.filters.length === 1 && !source.categories?.length && yearsExp === 0)
        return 0;
    if (season?.value !== '2')
        return null;
    for (const category of source.categories ?? []) {
        if (!category)
            continue;
        const index = gamesIndex(category);
        if (index < 0)
            continue;
        return Array.isArray(category.totals) ? gamesNumber(category.totals[index]) : null;
    }
    return null;
}
function careerFirstSeasonYear(payload) {
    const source = nbaCareer(payload);
    if (!source?.filters?.some(filter => filter?.name === 'seasontype' && filter.value === '2'))
        return null;
    const years = [];
    for (const category of source.categories ?? []) {
        if (!category || !Array.isArray(category.statistics))
            continue;
        const index = gamesIndex(category);
        if (index < 0)
            continue;
        for (const row of category.statistics) {
            const year = row?.season?.year;
            const games = Array.isArray(row?.stats) ? gamesNumber(row.stats[index]) : null;
            if (typeof year === 'number' && Number.isInteger(year) && year > 1946 && games !== null && games > 0)
                years.push(year);
        }
    }
    return years.length > 0 ? Math.min(...years) : null;
}
function careerGamesPrior(payload, coverageSeason = 2021) {
    const source = nbaCareer(payload);
    const total = careerRegularSeasonGames(payload);
    if (!source || total === null)
        return null;
    for (const category of source.categories ?? []) {
        if (!category)
            continue;
        const index = gamesIndex(category);
        if (index < 0 || !Array.isArray(category.statistics) || category.statistics.length === 0)
            continue;
        const seasons = new Map();
        for (const row of category.statistics) {
            const year = row?.season?.year;
            const games = Array.isArray(row?.stats) ? gamesNumber(row.stats[index]) : null;
            if (!Number.isInteger(year) || year <= 1946 || games === null)
                return null;
            const season = seasons.get(year) ?? { parts: 0, total: null };
            if (/\bTotals$/i.test(row.displayName ?? '')) {
                if (season.total !== null && season.total !== games)
                    return null;
                season.total = games;
            }
            else {
                season.parts += games;
            }
            seasons.set(year, season);
        }
        let sum = 0;
        let prior = 0;
        for (const [year, season] of seasons) {
            if (season.total !== null && season.parts > 0 && season.total !== season.parts)
                return null;
            const games = season.total ?? season.parts;
            sum += games;
            if (year < coverageSeason)
                prior += games;
        }
        return sum === total ? prior : null;
    }
    return null;
}
