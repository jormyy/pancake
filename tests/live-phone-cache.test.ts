import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLivePoller, fetchLiveSnapshot } from '../core/src/live/poll'
import { createSharedHttpCache } from '../scripts/bench/game-night/http-cache.mjs'
import type { LiveSnapshot } from '../core/src/live/overlay'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('ten phones behind the shared cache', () => {
    it('keeps all phones within 45 seconds without exceeding two requests per cache interval', async () => {
        vi.useFakeTimers()
        const start = Date.parse('2026-10-31T23:00:00Z')
        vi.setSystemTime(start)
        const arrivals: { at: number; source: number }[][] = Array.from({ length: 10 }, () => [])
        const cache = createSharedHttpCache(async () => {
            await new Promise(resolve => setTimeout(resolve, 350))
            return Response.json({ version: 1, mode: 'public', date: '2026-10-31', capturedAt: Date.now(), games: [] },
                { headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=15, stale-if-error=90' } })
        })
        vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
            expect(init.credentials).toBe('omit')
            expect(new Headers(init.headers).has('authorization')).toBe(false)
            return cache.fetch(new Request(url, init))
        })
        const phones = arrivals.map((values, index) => {
            const phone = createLivePoller({ load: (date, signal) => fetchLiveSnapshot(`http://local/api/live/${date}`, signal),
                onSnapshot: (snapshot: LiveSnapshot | null) => { if (snapshot) values.push({ at: Date.now() - start, source: snapshot.capturedAt - start }) } })
            setTimeout(() => phone.update({ date: '2026-10-31', active: true, visible: true, online: true }), index * 150)
            return phone
        })
        await vi.advanceTimersByTimeAsync(300000)
        for (const values of arrivals) {
            expect(values.length).toBeGreaterThan(10)
            for (let change = 20000; change <= 240000; change += 20000) {
                const arrival = values.find(value => value.source >= change)
                expect(arrival!.at - change).toBeLessThanOrEqual(45000)
            }
        }
        expect(cache.counters.requests).toBeLessThanOrEqual(210)
        expect(cache.counters.originRequests).toBeLessThanOrEqual(11)
        phones.forEach(phone => phone.dispose())
    })
})
