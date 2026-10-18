import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ stats: vi.fn(), games: vi.fn() }))
vi.mock('@/lib/games', () => ({ getLivePlayerStats: boundary.stats, getGameDay: boundary.games }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let useLiveStats: typeof import('@/hooks/use-live-stats').useLiveStats
let renderer: ReactTestRenderer | null
let latest: ReturnType<typeof useLiveStats>
type Selection = { date?: string; scope?: string; ids?: string[] }
const Probe = ({ date = '2026-10-18', scope, ids = [] }: Selection) => {
    latest = useLiveStats(date, scope ? { scope, playerIds: ids } : undefined)
    return null
}
const render = async (selection: Selection) => {
    await act(async () => {
        const element = React.createElement(Probe, selection)
        if (renderer) renderer.update(element)
        else renderer = create(element)
    })
}
beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    renderer = null
    boundary.games.mockResolvedValue({ games: [], startedTeams: new Set(['BOS']), teamMatchups: new Map() })
    boundary.stats.mockImplementation(async (date: string, ids: string[]) => new Map(ids.map(id => [id, { points: 7, date }])))
    ;({ useLiveStats } = await import('@/hooks/use-live-stats'))
})
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers() })

describe('live stat selection ownership', () => {
    it('reads only game locks for a consumer without player interest', async () => {
        await render({})
        expect(boundary.stats).not.toHaveBeenCalled()
        expect([...latest.startedTeams]).toEqual(['BOS'])
        expect(latest.liveStats.size).toBe(0)
    })

    it('reuses a fresh identical selection despite reordered and duplicate ids', async () => {
        await render({ scope: 'one', ids: ['b', 'a', 'a'] })
        await render({ scope: 'one', ids: ['a', 'b'] })
        expect(boundary.stats).toHaveBeenCalledExactlyOnceWith('2026-10-18', ['a', 'b'])
        expect([...latest.liveStats.keys()]).toEqual(['a', 'b'])
    })

    it.each(['scope', 'date', 'ids'] as const)('fences a pending response when %s changes', async field => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        boundary.stats.mockImplementationOnce(async () => { await gate; return new Map([['a', { points: 999 }]]) })
        await render({ scope: 'one', ids: ['a'] })
        const next = { scope: 'one', date: '2026-10-18', ids: ['a'] }
        if (field === 'scope') next.scope = 'two'
        if (field === 'date') next.date = '2026-10-19'
        if (field === 'ids') next.ids = ['b']
        await render(next)
        expect(latest.liveStats.get(next.ids[0])?.points).toBe(7)
        await act(async () => { release(); await gate })
        expect(latest.liveStats.get(next.ids[0])?.points).toBe(7)
        if (field === 'ids') expect(latest.liveStats.has('a')).toBe(false)
    })

    it('clears former players immediately while the replacement selection loads', async () => {
        await render({ scope: 'one', ids: ['a'] })
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        boundary.stats.mockImplementationOnce(async () => { await gate; return new Map([['b', { points: 9 }]]) })
        await render({ scope: 'one', ids: ['b'] })
        expect(latest.liveStats.size).toBe(0)
        await act(async () => { release(); await gate })
        expect([...latest.liveStats.keys()]).toEqual(['b'])
        await render({ scope: 'one', ids: [] })
        expect(latest.liveStats.size).toBe(0)
        expect(boundary.stats).toHaveBeenCalledTimes(2)
    })

    it('rejects an old session response and reads again after an account change', async () => {
        const { setSessionOwner } = await import('@/lib/session-cache-registry')
        setSessionOwner('one')
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        boundary.stats.mockImplementationOnce(async () => { await gate; return new Map([['a', { points: 999 }]]) })
        await render({ scope: 'same', ids: ['a'] })
        await act(async () => { setSessionOwner('two') })
        await render({ scope: 'same', ids: ['a'] })
        await act(async () => { release(); await gate })
        expect(latest.liveStats.get('a')?.points).toBe(7)
        expect(boundary.stats).toHaveBeenCalledTimes(2)
    })
})
