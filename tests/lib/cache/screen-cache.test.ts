import { cachedScreenView, clearScreenViews, invalidateScreenViews, readScreenView, refreshScreenVersions, saveScreenView, screenCacheKey, subscribeScreenView, type ScreenScope } from '@/lib/cache/screen-cache'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ owner: 'account', generation: 0, version: '1', changes: [] as { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[], listeners: new Set<(snapshot: { version: string; changes: { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[] }) => void>(), clears: [] as (() => void)[], check: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:59621/functions/v1/api' }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionOwner: () => mocks.owner, sessionGeneration: () => mocks.generation, onSessionCachesCleared: (callback: () => void) => mocks.clears.push(callback) }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: mocks.owner }, access_token: 'local-test' } } }) } } }))
vi.mock('@/lib/league-version', () => ({ compareLeagueVersions: (a: string, b: string) => BigInt(a) > BigInt(b) ? 1 : BigInt(a) < BigInt(b) ? -1 : 0, leagueVersionSnapshot: () => ({ version: mocks.version, changes: mocks.changes }), readLeagueVersion: async () => { mocks.check(); return { version: mocks.version, changes: mocks.changes } }, subscribeLeagueVersion: (_league: string, listener: (snapshot: { version: string; changes: { version: string; topic: string; scope: Record<string, unknown>; created_at: string }[] }) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } }))
const scope: ScreenScope = { accountId: 'account', leagueId: 'league', memberId: 'member', seasonId: 'season', screen: 'roster', params: { date: '2026-10-27' } }
function bump(topic: string) {
    mocks.version = String(Number(mocks.version) + 1)
    mocks.changes = [{ version: mocks.version, topic, scope: { topics: [topic] }, created_at: '2026-10-27' }]
    for (const listener of mocks.listeners) listener({ version: mocks.version, changes: mocks.changes })
}
beforeEach(() => {
    setLeagueChangesConnected('league', false)
    clearScreenViews(); mocks.listeners.clear(); mocks.owner = 'account'; mocks.generation = 0; mocks.version = '1'; mocks.changes = []; mocks.check.mockClear(); mocks.fetch.mockReset(); vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('fetch', mocks.fetch)
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, view: { claims: [{ status: 'awarded' }] } }), { status: 200 }))
})
describe('versioned screen cache', () => {
    it('expires stale connected authority and shares the resulting HTTP proof', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
        try {
            saveScreenView(scope, { rows: ['saved'] }, '1')
            setLeagueChangesConnected('league', true)
            notifyLeagueChange('league', { topic: 'version', version: '1', changes: [], scopes: null })
            await readScreenView(scope)
            expect(mocks.check).not.toHaveBeenCalled()
            clock.mockReturnValue(1_031_000)
            await readScreenView(scope)
            expect(mocks.check).toHaveBeenCalledOnce()
            await readScreenView(scope)
            expect(mocks.check).toHaveBeenCalledOnce()
            expect(mocks.fetch).not.toHaveBeenCalled()
        } finally { clock.mockRestore() }
    })
    it('keeps the version carried by a refreshed Home response after a missing hint', async () => {
        const selected: ScreenScope = { ...scope, screen: 'home' }
        mocks.fetch.mockResolvedValue(Response.json({ ok: true, view: { context: { version: '2' }, rows: ['new'] } }))
        await readScreenView(selected, { force: true, checkVersion: false })
        expect(cachedScreenView(selected)?.version).toBe('2')
        mocks.version = '2'; mocks.changes = [{ version: '2', topic: 'score', scope: {}, created_at: '' }]
        await readScreenView(selected)
        expect(mocks.fetch).toHaveBeenCalledOnce()
    })
    it('checks HTTP when its applied counter is behind a hint with no version subscriber', async () => {
        saveScreenView(scope, { rows: ['saved'] }, '1')
        setLeagueChangesConnected('league', true)
        notifyLeagueChange('league', { topic: 'version', version: '2', changes: [], scopes: null })
        await readScreenView(scope)
        expect(mocks.check).toHaveBeenCalledOnce()
    })
    it('uses connected version hints for cached reads and checks again after disconnect', async () => {
        saveScreenView(scope, { rows: ['saved'] }, '1')
        setLeagueChangesConnected('league', true)
        await readScreenView(scope)
        expect(mocks.check).toHaveBeenCalledOnce()
        notifyLeagueChange('league', { topic: 'version', version: '1', changes: [], scopes: null })
        await readScreenView(scope)
        expect(mocks.check).toHaveBeenCalledOnce()
        expect(mocks.fetch).not.toHaveBeenCalled()
        setLeagueChangesConnected('league', false)
        await readScreenView(scope)
        expect(mocks.check).toHaveBeenCalledTimes(2)
    })
    it('keeps mutation checks and reloads changed screens while version hints are connected', async () => {
        saveScreenView(scope, { rows: ['saved'] }, '1')
        setLeagueChangesConnected('league', true)
        notifyLeagueChange('league', { topic: 'version', version: '1', changes: [], scopes: null })
        await refreshScreenVersions('league')
        expect(mocks.check).toHaveBeenCalledOnce()
        const stop = subscribeScreenView(scope, () => {})
        bump('roster')
        await readScreenView(scope)
        expect(mocks.check).toHaveBeenCalledOnce()
        expect(mocks.fetch).toHaveBeenCalledOnce()
        stop()
    })
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
    it('waits for the shared push baseline before its one cold screen request', async () => {
        vi.stubGlobal('window', { WebSocket: class {} })
        const { setLeagueChangesConnected, notifyLeagueChange } = await import('@/lib/league-changes')
        const selected = { ...scope, leagueId: 'baseline-league' }
        const task = readScreenView(selected, { checkVersion: false })
        await new Promise(resolve => setImmediate(resolve))
        expect(mocks.fetch).not.toHaveBeenCalled()
        setLeagueChangesConnected(selected.leagueId, true)
        notifyLeagueChange(selected.leagueId, { topic: 'catchup', scopes: null })
        await task
        expect(mocks.fetch).toHaveBeenCalledOnce()
        expect(mocks.check).not.toHaveBeenCalled()
        setLeagueChangesConnected(selected.leagueId, false)
        vi.stubGlobal('window', undefined)
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

it('keeps the published schedule version when the first push baseline has not arrived', async () => {
    const scheduleScope: ScreenScope = { ...scope, screen: 'league-schedule' }
    mocks.version = '0'
    const value = { context: { version: '7' }, schedule: [{ weekNumber: 1 }] }
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, view: value })))
    expect(await readScreenView(scheduleScope, { checkVersion: false })).toEqual(value)
    expect(cachedScreenView(scheduleScope)?.version).toBe('7')
    mocks.version = '7'
    expect(await readScreenView(scheduleScope)).toEqual(value)
    expect(mocks.fetch).toHaveBeenCalledOnce()
})
