"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveLineStats = liveLineStats;
exports.overlayLiveScores = overlayLiveScores;
const formula_1 = require("../scoring/formula");
function liveLineStats(row) {
    if (row.length !== 19 || !/^\d+$/.test(row[0]) || row.slice(1).some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 2147483647))
        return null;
    if (row.slice(1).some((value, index) => index !== 15 && Number(value) < 0) || ![0, 1].includes(row[18]))
        return null;
    const doubles = [row[1], row[2], row[3], row[4], row[5]].filter(value => value >= 10).length;
    return { points: row[1], rebounds: row[2], assists: row[3], steals: row[4], blocks: row[5], turnovers: row[6],
        threePointersMade: row[7], threePointersAttempted: row[8], fieldGoalsMade: row[9], fieldGoalsAttempted: row[10],
        freeThrowsMade: row[11], freeThrowsAttempted: row[12], offensiveRebounds: row[13], defensiveRebounds: row[14],
        fouls: row[15], plusMinus: row[16], minutesPlayed: row[17], didNotPlay: row[18] === 1,
        doubleDouble: doubles >= 2, tripleDouble: doubles >= 3 };
}
function overlayLiveScores(saved, snapshot, settings, now) {
    const mode = snapshot?.mode ?? 'public';
    const usable = snapshot?.version === 1 && Number.isFinite(snapshot.capturedAt)
        && snapshot.capturedAt <= now + 5000 && now - snapshot.capturedAt <= 120000;
    const stats = {};
    const matchups = saved.map(matchup => {
        let homePoints = matchup.homePoints, awayPoints = matchup.awayPoints;
        let stale = !matchup.finalized && mode === 'public' && !usable;
        const pendingStats = {};
        const seen = new Set();
        if (usable && mode === 'public' && !matchup.finalized)
            for (const player of matchup.players) {
                const key = `${player.memberId}:${player.playerId}:${player.gameId}`;
                if (seen.has(key)) {
                    stale = true;
                    continue;
                }
                seen.add(key);
                const games = snapshot.games.filter(game => player.gameId ? game.nbaId === player.gameId
                    || game.nbaId == null && [game.home.team, game.away.team].includes(player.team ?? '')
                    : [game.home.team, game.away.team].includes(player.team ?? ''));
                if (!games.length) {
                    if (player.gameId)
                        stale = true;
                    continue;
                }
                if (games.length !== 1) {
                    stale = true;
                    continue;
                }
                const game = games[0];
                if (game.status === 'Scheduled')
                    continue;
                if (!Number.isFinite(game.updatedAt) || game.updatedAt > now + 5000 || now - game.updatedAt > 120000) {
                    stale = true;
                    continue;
                }
                if (game.updatedAt < player.savedAt)
                    continue;
                const providerId = game.source === 'espn' ? player.espnId : player.nbaId;
                const team = [game.home, game.away].find(side => side.team === player.team);
                const rows = (team?.players ?? []).filter(row => row[0] === providerId);
                const values = rows.length === 1 ? liveLineStats(rows[0]) : null;
                if (!values) {
                    if (player.starter)
                        stale = true;
                    continue;
                }
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
