"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MATCHUP_FORECAST_VERSION = void 0;
exports.sampleScoringVariation = sampleScoringVariation;
exports.estimateMatchup = estimateMatchup;
exports.MATCHUP_FORECAST_VERSION = 'independent-games-v1';
function sampleScoringVariation(values) {
    if (values.some(value => !Number.isFinite(value)))
        throw new Error('Scoring observations must be finite.');
    if (values.length < 5)
        return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    return { mean, variance, samples: values.length };
}
function normalCdf(value) {
    if (value === 0)
        return 0.5;
    const magnitude = Math.abs(value);
    const t = 1 / (1 + 0.2316419 * magnitude);
    const tail = Math.exp(-magnitude * magnitude / 2) / Math.sqrt(2 * Math.PI) * t *
        (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return Math.min(1, Math.max(0, value > 0 ? 1 - tail : tail));
}
function estimateMatchup(scores, games, missingInputs = []) {
    if (scores.length !== 2 || new Set(scores.map(team => team.memberId)).size !== 2 ||
        scores.some(team => !team.memberId || !Number.isFinite(team.currentPoints))) {
        throw new Error('A forecast requires two distinct teams and finite current scores.');
    }
    const members = new Set(scores.map(team => team.memberId));
    const seen = new Set();
    for (const game of games) {
        const identity = `${game.playerId}:${game.gameId}`;
        if (!game.playerId || !game.gameId || !members.has(game.memberId) || seen.has(identity)) {
            throw new Error('A forecast game must identify one player, game, and participating owner.');
        }
        if (game.expectedPoints !== null && !Number.isFinite(game.expectedPoints) ||
            game.variance !== null && (!Number.isFinite(game.variance) || game.variance < 0)) {
            throw new Error('Forecast points and scoring variation must be valid numbers.');
        }
        seen.add(identity);
    }
    const missing = new Set(missingInputs);
    const teams = scores.map(team => {
        const remaining = games.filter(game => game.memberId === team.memberId && game.eligible && !game.completed);
        const covered = remaining.filter(game => game.expectedPoints !== null);
        for (const game of remaining) {
            if (game.expectedPoints === null)
                missing.add(`Projection unavailable: ${game.playerId}`);
            if (game.variance === null)
                missing.add(`Scoring history unavailable: ${game.playerId}`);
        }
        return {
            ...team,
            projectedFinal: covered.length === remaining.length
                ? team.currentPoints + covered.reduce((sum, game) => sum + (game.expectedPoints ?? 0), 0) : null,
            winProbability: null,
            remainingGames: remaining.length,
            coveredGames: covered.length,
            variance: remaining.every(game => game.variance !== null)
                ? remaining.reduce((sum, game) => sum + (game.variance ?? 0), 0) : null,
        };
    });
    let tieProbability = null;
    if (missing.size === 0) {
        const left = teams[0].projectedFinal;
        const right = teams[1].projectedFinal;
        const variance = (teams[0].variance ?? 0) + (teams[1].variance ?? 0);
        if (left !== null && right !== null) {
            if (variance === 0) {
                teams[0].winProbability = left > right ? 1 : 0;
                teams[1].winProbability = right > left ? 1 : 0;
                tieProbability = left === right ? 1 : 0;
            }
            else {
                teams[0].winProbability = normalCdf((left - right) / Math.sqrt(variance));
                teams[1].winProbability = 1 - teams[0].winProbability;
                tieProbability = 0;
            }
        }
    }
    return {
        modelVersion: exports.MATCHUP_FORECAST_VERSION,
        status: missing.size === 0 ? 'available' : teams.some(team => team.coveredGames > 0) ? 'limited' : 'unavailable',
        teams,
        tieProbability,
        missingInputs: [...missing].sort(),
    };
}
