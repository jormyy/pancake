"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIVE_PHONE_POLL_MS = void 0;
exports.fetchLiveSnapshot = fetchLiveSnapshot;
exports.readLiveSnapshot = readLiveSnapshot;
exports.createLivePoller = createLivePoller;
const codec_1 = require("./codec");
exports.LIVE_PHONE_POLL_MS = 30000;
async function fetchLiveSnapshot(url, signal) {
    const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1000000)
        throw new Error('Live snapshot is unavailable');
    const body = await response.text();
    if (new TextEncoder().encode(body).length > 1000000)
        throw new Error('Live snapshot is too large');
    return { body: JSON.parse(body), ageMs: Math.max(0, Number(response.headers.get('age') ?? 0) * 1000), cache: response.headers.get('x-vercel-cache') ?? '' };
}
function readLiveSnapshot(value, date, now) {
    if (!value || typeof value !== 'object')
        return null;
    const source = value;
    if (source.version !== 1 || source.date !== date || !['public', 'database'].includes(source.mode)
        || !Number.isFinite(source.capturedAt) || source.capturedAt > now + 5000 || source.capturedAt < now - 120000
        || !Array.isArray(source.games) || source.games.length > 15)
        return null;
    if (source.mode === 'database')
        return source.games.length ? null : { version: 1, mode: 'database', date, capturedAt: source.capturedAt, games: [] };
    const games = [];
    const ids = new Set();
    for (const game of source.games) {
        if (!game || typeof game.id !== 'string' || ids.has(game.id) || !['Scheduled', 'InProgress', 'Final'].includes(game.status)
            || ![null, 'string'].includes(game.nbaId === null ? null : typeof game.nbaId)
            || ![null, 'string'].includes(game.espnId === null ? null : typeof game.espnId)
            || !['nba', 'espn'].includes(game.source ?? 'nba') || !Number.isFinite(game.updatedAt))
            return null;
        ids.add(game.id);
        const teams = [game.home, game.away];
        const playerIds = new Set();
        if (teams.some(team => !team || !/^[A-Z]{2,4}$/.test(team.team) || !Number.isFinite(team.score)
            || !Array.isArray(team.players) || team.players.length > 50) || game.home.team === game.away.team)
            return null;
        for (const team of teams)
            for (const row of team.players) {
                if (!Array.isArray(row) || !(0, codec_1.liveLineStats)(row) || playerIds.has(row[0]))
                    return null;
                playerIds.add(row[0]);
            }
        games.push(game);
    }
    return { version: 1, mode: 'public', date, capturedAt: source.capturedAt, games };
}
function createLivePoller(options) {
    const now = options.now ?? Date.now;
    let scope = null;
    let timer;
    let controller;
    let generation = 0;
    let retriedSnapshot = -1;
    const stop = () => {
        generation++;
        clearTimeout(timer);
        timer = undefined;
        controller?.abort();
        controller = undefined;
    };
    const poll = async (version) => {
        if (!scope || generation !== version)
            return;
        const started = now(), date = scope.date;
        const request = new AbortController();
        let delay = exports.LIVE_PHONE_POLL_MS;
        controller = request;
        const timeout = setTimeout(() => request.abort(), 5000);
        try {
            const result = await options.load(date, request.signal);
            if (generation === version && !request.signal.aborted) {
                const snapshot = readLiveSnapshot(result.body, date, now());
                options.onSnapshot(snapshot);
                if (snapshot && result.cache === 'STALE' && retriedSnapshot !== snapshot.capturedAt) {
                    retriedSnapshot = snapshot.capturedAt;
                    delay = 1000;
                }
                else if (snapshot && result.cache !== 'STALE' && Number.isFinite(result.ageMs)) {
                    delay = Math.max(1000, exports.LIVE_PHONE_POLL_MS - result.ageMs + 500);
                }
            }
        }
        catch {
            if (generation === version)
                options.onSnapshot(null);
        }
        finally {
            clearTimeout(timeout);
            if (generation === version) {
                if (request.signal.aborted)
                    options.onSnapshot(null);
                controller = undefined;
                timer = setTimeout(() => { void poll(version); }, Math.max(1, delay - (now() - started)));
            }
        }
    };
    return {
        update(next) {
            if (scope && Object.keys(next).every(key => next[key] === scope[key]))
                return;
            stop();
            scope = next;
            options.onSnapshot(null);
            if (next.active && next.visible && next.online)
                void poll(generation);
        },
        dispose() { stop(); scope = null; },
    };
}
