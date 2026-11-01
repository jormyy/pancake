import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLiveHandler } from '../server/live/handler'
import { createSharedHttpCache } from '../scripts/bench/game-night/http-cache.mjs'
import { createLivePoller, fetchLiveSnapshot, overlayLiveScores } from '@pancake/core'
import type { LiveSnapshot, SavedLiveMatchup } from '@pancake/core'

const date = '2026-10-31'
const saved: SavedLiveMatchup[] = [{ id: 'm', homeMemberId: 'a', awayMemberId: 'b', homePoints: 100, awayPoints: 80,
    finalized: false, players: [{ playerId: 'p', memberId: 'a', nbaId: '10', espnId: null, team: 'BOS',
        gameId: '0021', savedPoints: 10, savedAt: 0, starter: true }] }]

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function setup() {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(`${date}T23:00:00Z`))
    const state = { disabled: false, outage: false, points: 14, calls: 0 }
    const handler = createLiveHandler({ disabled: () => state.disabled, source: async () => {
        if (state.outage) throw new Error('Feed outage')
        return { version: 1, mode: 'public', date, capturedAt: Date.now(), games: [{ id: '0021', nbaId: '0021', espnId: null,
            status: 'InProgress', updatedAt: Date.now(), home: { team: 'BOS', score: state.points,
                players: [['10', state.points, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25, 0]] },
            away: { team: 'NYK', score: 0, players: [] } }] }
    } })
    const cache = createSharedHttpCache(handler)
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => { state.calls++; return cache.fetch(new Request(url, init)) })
    const phone = () => {
        const values: { at: number; snapshot: LiveSnapshot | null; homePoints: number; stale: boolean }[] = []
        const poller = createLivePoller({ load: (day, signal) => fetchLiveSnapshot(`http://local/api/live/${day}`, signal),
            onSnapshot: snapshot => { const score = overlayLiveScores(saved, snapshot, { points: 1 }, Date.now()).matchups[0]; values.push({ at: Date.now(), snapshot, homePoints: score.homePoints, stale: score.stale }) } })
        poller.update({ date, active: true, visible: true, online: true })
        return { values, poller }
    }
    return { state, phone }
}

describe('phone recovery through the public route and cache', () => {
    it('falls back after a feed outage outlasts the two-minute bound', async () => {
        const { state, phone } = setup()
        const client = phone()
        await vi.advanceTimersByTimeAsync(1)
        expect(client.values.at(-1)?.homePoints).toBe(104)
        state.outage = true
        await vi.advanceTimersByTimeAsync(180000)
        expect(client.values.at(-1)).toMatchObject({ homePoints: 100, stale: true, snapshot: null })
        client.poller.dispose()
    })

    it('makes no hidden requests and opens mid-game with the current score', async () => {
        const { state, phone } = setup()
        const client = phone()
        await vi.advanceTimersByTimeAsync(1)
        client.poller.update({ date, active: true, visible: false, online: true })
        const calls = state.calls
        state.points = 20
        await vi.advanceTimersByTimeAsync(60000)
        expect(state.calls).toBe(calls)
        client.poller.update({ date, active: true, visible: true, online: true })
        await vi.advanceTimersByTimeAsync(2000)
        expect(client.values.at(-1)).toMatchObject({ homePoints: 110, stale: false })
        const opened = phone()
        await vi.advanceTimersByTimeAsync(1)
        expect(opened.values.at(-1)).toMatchObject({ homePoints: 110, stale: false })
        client.poller.dispose(); opened.poller.dispose()
    })

    it('reconnects without retaining a failed snapshot and honors the server off switch', async () => {
        const { state, phone } = setup()
        const client = phone()
        await vi.advanceTimersByTimeAsync(1)
        client.poller.update({ date, active: true, visible: true, online: false })
        state.points = 22
        await vi.advanceTimersByTimeAsync(60000)
        client.poller.update({ date, active: true, visible: true, online: true })
        await vi.advanceTimersByTimeAsync(2000)
        expect(client.values.at(-1)).toMatchObject({ homePoints: 112, stale: false })
        state.disabled = true
        await vi.advanceTimersByTimeAsync(62000)
        expect(client.values.at(-1)).toMatchObject({ homePoints: 100, snapshot: { mode: 'database' } })
        client.poller.dispose()
    })
})
