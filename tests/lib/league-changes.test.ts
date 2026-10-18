import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferLeagueRefresh, leagueChangeAffects, leagueChangeReceiver, listenForLeagueChanges, notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'

let page: EventTarget
let events: EventTarget
let hidden: boolean
let online: boolean
beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    online = true
    page = new EventTarget()
    events = new EventTarget()
    Object.defineProperty(page, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', events)
    vi.stubGlobal('navigator', { get onLine() { return online } })
})
afterEach(() => { setLeagueChangesConnected('league', false); vi.useRealTimers(); vi.unstubAllGlobals() })
const advance = async (ms = 200) => { await vi.advanceTimersByTimeAsync(ms) }
const row = (revision: number | string, scopes: unknown = [{ season_id: 'season', member_id: 'mine', date: '2026-10-18' }]) => ({ league_id: 'league', topic: 'lineup', revision, scopes })

describe('compact league changes', () => {
    it('rejects duplicate and reversed revisions but broadens a missed revision', () => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume(row(5))
        consume(row(5))
        consume(row(4))
        consume(row(7, [{ season_id: 'different' }]))
        consume(row(8))
        expect(receive.mock.calls.map(([change]) => change.scopes)).toEqual([row(5).scopes, null, row(8).scopes])
    })

    it('does not advance the cursor for another league or malformed scope data', () => {
        const receive = vi.fn()
        const consume = leagueChangeReceiver('league', receive)
        consume({ ...row(8), league_id: 'another' })
        consume(row(8, [{ season_id: 123 }]))
        consume(row('invalid'))
        consume(row('9007199254740993', null))
        consume(row('9007199254740994'))
        expect(receive).toHaveBeenCalledTimes(2)
        expect(receive.mock.calls.at(-1)?.[0].scopes).toEqual(row(1).scopes)
    })

    it('matches day, season and visible members, including historical and broad changes', () => {
        const selected = { seasonId: 'season', memberIds: ['mine', 'theirs'], date: '2026-10-18' }
        expect(leagueChangeAffects({ topic: 'lineup', scopes: [{ season_id: 'season', member_id: 'mine', date: selected.date }] }, selected)).toBe(true)
        expect(leagueChangeAffects({ topic: 'lineup', scopes: [{ season_id: 'season', member_id: 'other', date: selected.date }] }, selected)).toBe(false)
        expect(leagueChangeAffects({ topic: 'stat', scopes: [{ season_id: 'season', date: '2026-10-17' }] }, selected)).toBe(false)
        expect(leagueChangeAffects({ topic: 'game', scopes: [{ season_id: 'past-season', date: selected.date }] }, selected)).toBe(false)
        expect(leagueChangeAffects({ topic: 'roster', scopes: [{ season_id: 'season', member_id: 'theirs' }] }, selected)).toBe(true)
        expect(leagueChangeAffects({ topic: 'catchup', scopes: null }, selected)).toBe(true)
    })

    it('catches a new observer up once and removes its callback on cleanup', () => {
        setLeagueChangesConnected('league', true)
        const listener = vi.fn()
        const stop = listenForLeagueChanges('league', listener)
        notifyLeagueChange('other', { topic: 'stat', scopes: null })
        notifyLeagueChange('league', { topic: 'roster', scopes: null })
        stop()
        notifyLeagueChange('league', { topic: 'lineup', scopes: null })
        expect(listener.mock.calls).toEqual([[{ topic: 'catchup', scopes: null }], [{ topic: 'roster', scopes: null }]])
    })
})

describe('changed resource reads', () => {
    it('coalesces a burst, pauses while hidden or offline, and catches up on return', async () => {
        const read = vi.fn().mockResolvedValue(true)
        const refresh = deferLeagueRefresh(read)
        hidden = true
        refresh.trigger(); refresh.trigger(); refresh.trigger()
        await advance(3000)
        expect(read).not.toHaveBeenCalled()
        hidden = false; online = false
        page.dispatchEvent(new Event('visibilitychange'))
        await advance()
        expect(read).not.toHaveBeenCalled()
        online = true
        events.dispatchEvent(new Event('online'))
        page.dispatchEvent(new Event('visibilitychange'))
        await advance()
        expect(read).toHaveBeenCalledOnce()
        refresh.cancel()
    })

    it('queues one follow-up after a held read and never overlaps requests', async () => {
        let release!: () => void
        const pending = new Promise<void>(resolve => { release = resolve })
        const read = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(true)
        const refresh = deferLeagueRefresh(read)
        refresh.trigger(); await advance()
        refresh.trigger(); refresh.trigger(); await advance(5000)
        expect(read).toHaveBeenCalledOnce()
        release(); await advance()
        expect(read).toHaveBeenCalledTimes(2)
        refresh.cancel()
    })

    it('keeps a maximum wait while changes continue without a quiet gap', async () => {
        const reads: number[] = []
        const read = vi.fn(async () => { reads.push(Date.now()) })
        const started = Date.now()
        const refresh = deferLeagueRefresh(read)
        for (let event = 0; event < 50; event++) { refresh.trigger(); await advance(100) }
        expect(reads.length).toBeGreaterThanOrEqual(4)
        expect(reads.length).toBeLessThanOrEqual(6)
        expect(reads[0] - started).toBeLessThanOrEqual(1000)
        expect(Math.max(...reads.slice(1).map((at, index) => at - reads[index]))).toBeLessThanOrEqual(1000)
        refresh.cancel()
    })

    it('bounds failed retries, accepts a fresh signal, and cancels queued work', async () => {
        const read = vi.fn().mockResolvedValue(false)
        const refresh = deferLeagueRefresh(read)
        refresh.trigger()
        await advance(20000)
        expect(read).toHaveBeenCalledTimes(3)
        read.mockResolvedValue(true)
        refresh.trigger(); await advance()
        expect(read).toHaveBeenCalledTimes(4)
        refresh.trigger(); refresh.cancel()
        events.dispatchEvent(new Event('online')); page.dispatchEvent(new Event('visibilitychange'))
        await advance(20000)
        expect(read).toHaveBeenCalledTimes(4)
    })
})

it('bounds the initial join wait and releases it when the authenticated stream joins', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { WebSocket: function WebSocket() {} })
    const changes = await import('@/lib/league-changes')
    let joined = false
    const first = changes.waitForLeagueChanges('join-wait').then(() => { joined = true })
    await vi.advanceTimersByTimeAsync(299)
    expect(joined).toBe(false)
    changes.setLeagueChangesConnected('join-wait', true)
    changes.notifyLeagueChange('join-wait', { topic: 'catchup', scopes: null })
    await first
    expect(joined).toBe(true)
    let expired = false
    const second = changes.waitForLeagueChanges('unavailable').then(() => { expired = true })
    await vi.advanceTimersByTimeAsync(299)
    expect(expired).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(expired).toBe(true)
    changes.setLeagueChangesConnected('join-wait', false)
    vi.unstubAllGlobals()
    vi.useRealTimers()
})
