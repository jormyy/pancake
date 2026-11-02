"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.homeHintAffects = homeHintAffects;
exports.homeVersionAffects = homeVersionAffects;
exports.homeForecastOnly = homeForecastOnly;
exports.mergeHomeForecast = mergeHomeForecast;
exports.homeScoresOnly = homeScoresOnly;
exports.mergeHomeScores = mergeHomeScores;
const topics = new Set(['roster', 'lineup', 'score', 'stat', 'player_stats', 'game', 'resources', 'inventory', 'announcement', 'forecast', 'settings', 'member', 'season']);
function homeHintAffects(hint, selection) {
    if (['score', 'resources'].includes(hint.topic) && Array.isArray(hint.details) && hint.details.length
        && hint.details.every(detail => detail?.resource === 'averages'))
        return false;
    if (hint.topic === 'inventory' && Array.isArray(hint.details) && hint.details.length
        && hint.details.every(detail => detail && ['picks', 'claims', 'waivers', 'priority', 'faab', 'activity'].includes(detail.resource)))
        return false;
    if (!Array.isArray(hint.scopes) || !hint.scopes.length || !selection.seasonId
        || hint.scopes.some(scope => !scope || typeof scope !== 'object'))
        return true;
    const firstWeek = ['score', 'stat', 'player_stats', 'game'].includes(hint.topic) ? selection.roundStartWeek ?? selection.week : selection.week;
    const lastWeek = ['score', 'stat', 'player_stats', 'game'].includes(hint.topic) ? selection.roundEndWeek ?? selection.week : selection.week;
    return hint.scopes.some(scope => (!scope.season_id || scope.season_id === selection.seasonId)
        && (scope.week == null || firstWeek == null || lastWeek == null || scope.week >= firstWeek && scope.week <= lastWeek)
        && (hint.topic !== 'lineup' || !scope.date || !selection.date || scope.date === selection.date)
        && (hint.topic !== 'roster' || !scope.member_id || !selection.memberIds?.length || selection.memberIds.includes(scope.member_id)));
}
function homeVersionAffects(change, selection) {
    if (change.topic === 'catchup')
        return true;
    if (change.scope.homeChanged === false)
        return false;
    const names = (Array.isArray(change.scope.topics) ? change.scope.topics : [change.topic])
        .map(topic => topic === 'members' ? 'member' : ['players', 'projections'].includes(String(topic)) ? 'resources' : topic === 'claims' ? 'claim' : topic);
    const hints = Array.isArray(change.scope.hints) ? change.scope.hints.filter((hint) => Boolean(hint && typeof hint === 'object' && typeof hint.topic === 'string')) : [];
    const known = new Set([...topics, 'trade', 'claim', 'draft', 'activity', 'profile']);
    return names.some(topic => {
        if (typeof topic !== 'string' || !known.has(topic))
            return true;
        if (!topics.has(topic))
            return false;
        if (topic === 'forecast' && selection.matchupId && Array.isArray(change.scope.forecastMatchupIds)
            && change.scope.forecastMatchupIds.length && change.scope.forecastMatchupIds.every(id => typeof id === 'string'))
            return change.scope.forecastMatchupIds.includes(selection.matchupId);
        const scoped = hints.filter(hint => hint.topic === topic);
        return scoped.length === 0 || scoped.some(hint => homeHintAffects(hint, selection));
    });
}
function homeForecastOnly(change) {
    const names = Array.isArray(change.scope.topics) ? change.scope.topics : [change.topic];
    const tables = change.scope.tables;
    return change.topic !== 'catchup' && names.length > 0 && names.every(name => name === 'forecast')
        && Array.isArray(tables) && tables.length > 0 && tables.every(table => table === 'matchup_forecasts');
}
function mergeHomeForecast(saved, update, version) {
    const previous = saved;
    const patch = update;
    if (!previous.context?.leagueId || !previous.context.seasonId || !previous.matchup?.id
        || patch?.section !== 'forecast' || !Object.hasOwn(patch, 'forecast')
        || patch.context?.leagueId !== previous.context.leagueId || patch.context?.seasonId !== previous.context.seasonId
        || String(patch.context?.version) !== version || patch.matchup?.id !== previous.matchup.id)
        return undefined;
    return { ...saved, context: { ...previous.context, version: patch.context.version }, forecast: patch.forecast };
}
function homeScoresOnly(change) {
    const names = Array.isArray(change.scope.topics) ? change.scope.topics : [change.topic];
    const tables = change.scope.tables;
    return change.topic !== 'catchup' && names.length > 0 && names.every(name => ['score', 'stat', 'player_stats', 'game'].includes(String(name)))
        && Array.isArray(tables) && tables.length > 0 && tables.every(table => ['nba_games', 'player_game_stats', 'matchups', 'matchup_totals'].includes(String(table)));
}
function mergeHomeScores(saved, update, version) {
    const previous = saved;
    const patch = update;
    if (!previous.context?.leagueId || !previous.context.seasonId || !previous.matchup?.id || !previous.selectedDate
        || patch?.section !== 'scores' || patch.context?.leagueId !== previous.context.leagueId
        || patch.context?.seasonId !== previous.context.seasonId || String(patch.context?.version) !== version
        || patch.matchup?.id !== previous.matchup.id || patch.selectedDate !== previous.selectedDate
        || !['weekDays', 'leagueMatchups', 'todaysGames', 'startedTeams', 'liveBasis'].every(name => Array.isArray(patch[name]))
        || Object.hasOwn(patch, 'liveGames') && !Array.isArray(patch.liveGames)
        || !['liveStats', 'teamMatchups'].every(name => patch[name] && typeof patch[name] === 'object' && !Array.isArray(patch[name]))
        || !(typeof patch.forecastStale === 'boolean' || patch.forecastStale === null))
        return undefined;
    const forecast = previous.forecast;
    if (forecast && (typeof forecast !== 'object' || patch.forecastStale === null))
        return undefined;
    return { ...saved, ...Object.fromEntries(['matchup', 'selectedDate', 'weekDays', 'leagueMatchups', 'todaysGames', 'liveStats', 'startedTeams', 'teamMatchups', 'liveBasis'].map(name => [name, patch[name]])),
        ...(Array.isArray(patch.liveGames) ? { liveGames: patch.liveGames } : {}),
        context: { ...previous.context, version: patch.context.version },
        ...(forecast ? { forecast: { ...forecast, stale: patch.forecastStale } } : {}) };
}
