import { cachedScreenView, clearScreenViews, invalidateScreenViews, readScreenView, saveScreenView, screenCacheKey, subscribeScreenView, type ScreenScope } from '@/lib/cache/screen-cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ owner: 'account', generation: 0, version: '1', changes: [] as { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[], listeners: new Set<(snapshot: { version: string; changes: { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[] }) => void>(), clears: [] as (() => void)[], check: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:59621/functions/v1/api' }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => mocks.generation, onSessionCachesCleared: (callback: () => void) => mocks.clears.push(callback) }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: mocks.owner }, access_token: 'local-test' } } }) } } }))
vi.mock('@/lib/league-version', () => ({ compareLeagueVersions: (a: string, b: string) => BigInt(a) > BigInt(b) ? 1 : BigInt(a) < BigInt(b) ? -1 : 0, leagueVersionSnapshot: () => ({ version: mocks.version, changes: mocks.changes }), readLeagueVersion: async () => { mocks.check(); return { version: mocks.version, changes: mocks.changes } }, subscribeLeagueVersion: (_league: string, listener: (snapshot: { version: string; changes: { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[] }) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } }))
const scope: ScreenScope = { accountId: 'account', leagueId: 'league', memberId: 'member', seasonId: 'season', screen: 'roster', params: { date: '2026-10-27' } }
function bump(topic: string) {
    mocks.version = String(Number(mocks.version) + 1)
    mocks.changes = [{ version: mocks.version, topic, scope: { topics: [topic] }, created_at: '2026-10-27' }]
    for (const listener of mocks.listeners) listener({ version: mocks.version, changes: mocks.changes })
}
beforeEach(() => {
    clearScreenViews(); mocks.listeners.clear(); mocks.owner = 'account'; mocks.generation = 0; mocks.version = '1'; mocks.changes = []; mocks.check.mockClear(); mocks.fetch.mockReset(); vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('fetch', mocks.fetch)
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, view: { claims: [{ status: 'awarded' }] } }), { status: 200 }))
})
describe('versioned screen cache', () => {
    it('normalizes parameter order and isolates every private key dimension', () => {
        expect(screenCacheKey({ ...scope, params: { a: 1, b: 2 } })).toBe(screenCacheKey({ ...scope, params: { b: 2, a: 1 } }))
        for (const change of [{ accountId: 'other' }, { leagueId: 'other' }, { memberId: 'other' }, { seasonId: 'other' }, { screen: 'players' as const }, { params: { date: 'tomorrow' } }]) expect(screenCacheKey({ ...scope, ...change })).not.toBe(screenCacheKey(scope))
    })
    it('coalesces one cold view and one version check, then reuses an unchanged result', async () => {
        const [first, second] = await Promise.all([readScreenView(scope), readScreenView(scope)])
        expect(first).toBe(second); expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.check).toHaveBeenCalledTimes(1)
        await readScreenView(scope)
        expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.check).toHaveBeenCalledTimes(2)
    })
    it('keeps an unrelated screen and refetches an awarded claim within one bump', async () => {
        saveScreenView(scope, { claims: [{ status: 'pending' }] }, '1')
        const stop = subscribeScreenView(scope, () => {})
        bump('draft'); await readScreenView(scope)
        expect(mocks.fetch).not.toHaveBeenCalled()
        bump('claims')
        expect(await readScreenView(scope)).toEqual({ claims: [{ status: 'awarded' }] })
        expect(mocks.fetch).toHaveBeenCalledTimes(1); stop()
    })
    it('refetches accepted trades and treats missing version ranges as catchup', async () => {
        const trades: ScreenScope = { ...scope, screen: 'trades' }
        saveScreenView(trades, { trades: [{ status: 'pending' }] }, '1')
        mocks.version = '3'; mocks.changes = [{ version: '3', topic: 'draft', scope: {}, created_at: '' }]
        await readScreenView(trades); expect(mocks.fetch).toHaveBeenCalledTimes(1)
        mocks.version = '4'; mocks.changes = [{ version: '4', topic: 'trade', scope: {}, created_at: '' }]
        mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, view: { trades: [{ status: 'accepted' }] } })))
        expect(await readScreenView(trades)).toEqual({ trades: [{ status: 'accepted' }] })
    })
    it('keeps saved content readable offline and makes no requests', async () => {
        saveScreenView(scope, { rows: ['saved'] }, '1'); vi.stubGlobal('navigator', { onLine: false })
        expect(await readScreenView(scope)).toEqual({ rows: ['saved'] }); expect(mocks.check).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled()
    })
    it('retains content after a failed refresh without marking it fresh', async () => {
        saveScreenView(scope, { rows: ['saved'] }, '1'); invalidateScreenViews('league'); mocks.fetch.mockRejectedValue(new Error('failed'))
        await expect(readScreenView(scope)).rejects.toThrow('failed'); expect(cachedScreenView(scope)).toMatchObject({ value: { rows: ['saved'] }, dirty: true })
    })
    it('rejects responses after account changes and league cache clearing', async () => {
        let finish!: (value: Response) => void
        mocks.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        const task = readScreenView(scope)
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
        clearScreenViews(); mocks.generation += 1; mocks.owner = 'other'; finish(new Response(JSON.stringify({ ok: true, view: { private: true } })))
        await expect(task).rejects.toThrow('changed'); expect(cachedScreenView(scope)).toBeUndefined()
    })
    it('rereads when a write arrives during a cold view read', async () => {
        let finish!: (value: Response) => void
        mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(new Response(JSON.stringify({ ok: true, view: { state: 'accepted' } })))
        const stop = subscribeScreenView(scope, () => {})
        const task = readScreenView(scope)
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1)); bump('trade'); finish(new Response(JSON.stringify({ ok: true, view: { state: 'old' } })))
        expect(await task).toEqual({ state: 'accepted' }); expect(mocks.fetch).toHaveBeenCalledTimes(2); stop()
    })
    it('bounds persisted entries and total bytes', () => {
        for (let index = 0; index < 60; index += 1) saveScreenView({ ...scope, params: { index } }, { text: 'x'.repeat(100_000) }, '1')
        const saved = Array.from({ length: 60 }, (_, index) => cachedScreenView({ ...scope, params: { index } })).filter(Boolean)
        expect(saved.length).toBeLessThanOrEqual(41); expect(saved.at(-1)?.value).toBeDefined()
    })
})
