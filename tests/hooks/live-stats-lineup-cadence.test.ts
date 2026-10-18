import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ stats: vi.fn(), games: vi.fn() }))
vi.mock('@/lib/games', () => ({ getLivePlayerStats: boundary.stats, getGameDay: boundary.games }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-10-18' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let useLiveStats: typeof import('@/hooks/use-live-stats').useLiveStats
let renderer: ReactTestRenderer | null
let events: EventTarget
let page: EventTarget
let hidden: boolean
const lineup = vi.fn()
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const mount = async () => {
    await act(async () => { renderer = create(React.createElement(() => {
        useLiveStats('2026-10-18', { scope: 'owner', playerIds: ['p1'], onSilentRefresh: lineup })
        return null
    })) })
}
beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
    vi.resetModules()
    vi.clearAllMocks()
    hidden = false
    events = new EventTarget()
    page = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('window', events)
    vi.stubGlobal('document', page)
    vi.stubGlobal('navigator', { onLine: true })
    boundary.games.mockResolvedValue({ games: [{ status: 'InProgress' }], startedTeams: new Set(), teamMatchups: new Map() })
    boundary.stats.mockResolvedValue(new Map([['p1', { points: 7 }]]))
    lineup.mockResolvedValue(true)
    ;({ useLiveStats } = await import('@/hooks/use-live-stats'))
    renderer = null
})
afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('lineup safety refresh', () => {
    it('keeps live stats on cadence but reads lineups only once each minute', async () => {
        await mount()
        await advance(15_000)
        expect(boundary.stats).toHaveBeenCalledTimes(2)
        expect(lineup).not.toHaveBeenCalled()
        await advance(105_000)
        expect(boundary.stats).toHaveBeenCalledTimes(9)
        expect(lineup).toHaveBeenCalledTimes(2)
    })

    it('catches up once after an online epoch or missed visible tick', async () => {
        await mount()
        await act(async () => { events.dispatchEvent(new Event('online')); events.dispatchEvent(new Event('focus')) })
        expect(lineup).toHaveBeenCalledOnce()
        hidden = true
        await advance(30_000)
        expect(boundary.stats).toHaveBeenCalledTimes(2)
        hidden = false
        await act(async () => { page.dispatchEvent(new Event('visibilitychange')); events.dispatchEvent(new Event('focus')) })
        expect(lineup).toHaveBeenCalledTimes(2)
    })

    it('retries a failed lineup read on the next live tick', async () => {
        lineup.mockResolvedValueOnce(false)
        await mount()
        await advance(60_000)
        expect(lineup).toHaveBeenCalledOnce()
        await advance(15_000)
        expect(lineup).toHaveBeenCalledTimes(2)
        await advance(45_000)
        expect(lineup).toHaveBeenCalledTimes(2)
    })

    it('keeps lineup safety available during a separate box-score outage', async () => {
        boundary.stats.mockRejectedValue(new Error('Stats unavailable'))
        await mount()
        await advance(60_000)
        expect(lineup).toHaveBeenCalledOnce()
        expect(boundary.stats).toHaveBeenCalledTimes(5)
    })

    it('does not block live stats or overlap a held lineup refresh', async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        lineup.mockReturnValueOnce(gate)
        await mount()
        await advance(135_000)
        expect(lineup).toHaveBeenCalledOnce()
        expect(boundary.stats).toHaveBeenCalledTimes(10)
        await act(async () => { release(); await gate })
        await advance(15_000)
        expect(lineup).toHaveBeenCalledOnce()
    })
})
