"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextLiveRecovery = nextLiveRecovery;
function nextLiveRecovery(games, now, publicLive) {
    const interval = publicLive ? 120000 : 20000;
    const scheduled = games.filter(game => game.status === 'Scheduled' && !/postpon|cancel|suspend/i.test(game.game_status_text ?? ''));
    if (games.some(game => game.status === 'InProgress') || scheduled.some(game => {
        const time = Date.parse(game.game_time ?? '');
        return Number.isFinite(time) && time <= now && now - time < 6 * 60 * 60_000;
    }))
        return interval;
    const times = scheduled.map(game => Date.parse(game.game_time ?? '')).filter(time => Number.isFinite(time) && time > now);
    if (times.length)
        return Math.min(Math.min(...times) - now, 2_147_483_647);
    return scheduled.some(game => !Number.isFinite(Date.parse(game.game_time ?? ''))) ? interval : null;
}
