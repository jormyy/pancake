"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gameAvailable = gameAvailable;
exports.gamePhase = gamePhase;
const UNAVAILABLE_TEXT = /postpon|cancel|suspend|(^|[^a-z])ppd([^a-z]|$)/i;
function gameAvailable(game) {
    return (game.status === 'Scheduled' || game.status === 'InProgress' || game.status === 'Final')
        && !UNAVAILABLE_TEXT.test(game.game_status_text ?? '');
}
function gamePhase(game) {
    if (!gameAvailable(game))
        return 'unavailable';
    if (game.status === 'Scheduled')
        return 'upcoming';
    if (game.status === 'InProgress')
        return 'live';
    return game.stats_synced_at === null ? 'finalPending' : 'settled';
}
