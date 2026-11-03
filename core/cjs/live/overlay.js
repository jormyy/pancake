"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveLineStats = void 0;
exports.overlayLiveScores = overlayLiveScores;
const formula_1 = require("../scoring/formula");
const codec_1 = require("./codec");
var codec_2 = require("./codec");
Object.defineProperty(exports, "liveLineStats", { enumerable: true, get: function () { return codec_2.liveLineStats; } });
function overlayLiveScores(saved, snapshot, settings, now) {
    const mode = snapshot?.mode ?? 'public';
    const usable = snapshot?.version === 1 && Number.isFinite(snapshot.capturedAt)
        && snapshot.capturedAt <= now + 5000 && now - snapshot.capturedAt <= 120000;
    const stats = {};
    const matchups = saved.map(matchup => {
        let homePoints = matchup.homePoints, awayPoints = matchup.awayPoints;
        let stale = !matchup.finalized && mode === 'public' && (!usable || matchup.ready === false);
        const pendingStats = {};
        const seen = new Set();
        const resolved = new Set();
        if (usable && mode === 'public' && !matchup.finalized)
            for (const player of [...matchup.players].sort((a, b) => Number(Boolean(b.gameId)) - Number(Boolean(a.gameId)))) {
                if (player.final)
                    continue;
                const key = `${player.memberId}:${player.playerId}:${player.gameDate}:${player.gameId}`;
                if (seen.has(key)) {
                    stale = true;
                    continue;
                }
                seen.add(key);
                const games = snapshot.games.filter(game => player.gameId && game.nbaId === player.gameId
                    || (game.gameDate ?? snapshot.date) === (player.gameDate ?? snapshot.date)
                        && (!player.gameId || game.nbaId == null) && [game.home.team, game.away.team].includes(player.team ?? ''));
                if (!games.length)
                    continue;
                if (games.length !== 1) {
                    stale = true;
                    continue;
                }
                const game = games[0];
                const resolvedKey = `${player.memberId}:${player.playerId}:${game.gameDate ?? snapshot.date}:${game.id}`;
                if (resolved.has(resolvedKey))
                    continue;
                resolved.add(resolvedKey);
                if (game.status === 'Scheduled')
                    continue;
                if (!Number.isFinite(game.updatedAt) || game.updatedAt > now + 5000) {
                    stale = true;
                    continue;
                }
                if (game.updatedAt <= player.savedAt)
                    continue;
                const providerId = game.source === 'espn' ? player.espnId : player.nbaId;
                const team = [game.home, game.away].find(side => side.team === player.team);
                const rows = (team?.players ?? []).filter(row => row[0] === providerId);
                const values = rows.length === 1 ? (0, codec_1.liveLineStats)(rows[0]) : null;
                if (!values) {
                    if (player.starter)
                        stale = true;
                    continue;
                }
                if ((game.gameDate ?? snapshot.date) === snapshot.date)
                    pendingStats[player.playerId] = values;
                if (!player.starter)
                    continue;
                const delta = (0, formula_1.calculateFantasyPoints)(values, settings) - player.savedPoints;
                if (player.memberId === matchup.homeMemberId)
                    homePoints += delta;
                else if (player.memberId === matchup.awayMemberId)
                    awayPoints += delta;
                else
                    stale = true;
            }
        if (!stale)
            Object.assign(stats, pendingStats);
        return { id: matchup.id, homeMemberId: matchup.homeMemberId, awayMemberId: matchup.awayMemberId,
            homePoints: stale ? matchup.homePoints : (0, formula_1.roundFantasyPoints)(homePoints),
            awayPoints: stale ? matchup.awayPoints : (0, formula_1.roundFantasyPoints)(awayPoints), stale };
    });
    return { mode, matchups, stats, stale: matchups.some(matchup => matchup.stale),
        live: usable && mode === 'public' && snapshot.games.some(game => game.status === 'InProgress') };
}
