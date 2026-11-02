import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLivePoller, readLiveSnapshot } from '../src/live/poll'
import type { LiveSnapshot } from '../src/live/overlay'

const date = '2026-10-31'
const active = { date, active: true, visible: true, online: true }
const snapshot = (): LiveSnapshot => ({ version: 1, mode: 'public', date, capturedAt: Date.now(), games: [] })
const result = () => ({ body: snapshot(), ageMs: 0, cache: '' })

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T23:00:00Z')) })
afterEach(() => vi.useRealTimers())

describe('shared phone polling', () => {
    it('fetches immediately on opening and stops while hidden or without live games', async () => {
        const load = vi.fn(async () => result())
        const poller = createLivePoller({ load, onSnapshot: vi.fn() })
        poller.update({ ...active, active: false })
        await vi.advanceTimersByTimeAsync(61000)
        expect(load).not.toHaveBeenCalled()
        poller.update(active)
        await vi.advanceTimersByTimeAsync(61000)
        expect(load).toHaveBeenCalledTimes(3)
        poller.update({ ...active, visible: false })
        await vi.advanceTimersByTimeAsync(60000)
        expect(load).toHaveBeenCalledTimes(3)
        poller.update(active)
        await vi.advanceTimersByTimeAsync(0)
        expect(load).toHaveBeenCalledTimes(4)
        poller.dispose()
    })

    it('falls back immediately on an outage and fetches immediately after reconnect', async () => {
        const updates: (LiveSnapshot | null)[] = []
        const load = vi.fn(async () => result())
        const poller = createLivePoller({ load, onSnapshot: value => updates.push(value) })
        poller.update(active)
        await vi.advanceTimersByTimeAsync(0)
        expect(updates.at(-1)?.mode).toBe('public')
        load.mockRejectedValueOnce(new Error('offline'))
        await vi.advanceTimersByTimeAsync(30500)
        expect(updates.at(-1)).toBeNull()
        poller.update({ ...active, online: false })
        await vi.advanceTimersByTimeAsync(60000)
        expect(load).toHaveBeenCalledTimes(2)
        poller.update(active)
        await vi.advanceTimersByTimeAsync(0)
        expect(load).toHaveBeenCalledTimes(3)
        expect(updates.at(-1)?.mode).toBe('public')
        poller.dispose()
    })

    it('discards late responses after hiding or changing the selected date', async () => {
        let release!: (value: unknown) => void
        const updates: (LiveSnapshot | null)[] = []
        const poller = createLivePoller({ load: () => new Promise(resolve => { release = value => resolve(value as ReturnType<typeof result>) }), onSnapshot: value => updates.push(value) })
        poller.update(active)
        poller.update({ ...active, visible: false })
        release(snapshot())
        await vi.advanceTimersByTimeAsync(60000)
        expect(updates.every(value => value === null)).toBe(true)
        poller.dispose()
    })

    it('rejects stale or malformed bodies and passes the server off switch', () => {
        const source = snapshot()
        expect(readLiveSnapshot({ ...source, capturedAt: Date.now() - 120001 }, date, Date.now())).toBeNull()
        expect(readLiveSnapshot({ ...source, date: '2026-10-30' }, date, Date.now())).toBeNull()
        expect(readLiveSnapshot({ ...source, games: [null] }, date, Date.now())).toBeNull()
        expect(readLiveSnapshot({ ...source, mode: 'database' }, date, Date.now())?.mode).toBe('database')
    })
})

it('keeps accepted game revisions through fallback, reconnect and newer corrections', async () => {
    const time=Date.now()
    const game={id:'nba',nbaId:'0021',espnId:'401',source:'nba' as const,status:'Final' as const,updatedAt:time,
        home:{team:'BOS',score:110,players:[]},away:{team:'NYK',score:100,players:[]}}
    let incoming:LiveSnapshot={...snapshot(),games:[game]}
    const updates:(LiveSnapshot|null)[]=[]
    const poller=createLivePoller({load:async()=>({body:incoming,ageMs:0,cache:''}),onSnapshot:value=>updates.push(value)})
    poller.update(active);await vi.advanceTimersByTimeAsync(0)
    incoming={...snapshot(),games:[{...game,id:'espn:401',nbaId:null,source:'espn',status:'InProgress',updatedAt:time-1000,home:{...game.home,score:108}}]}
    await vi.advanceTimersByTimeAsync(30500)
    expect(updates.at(-1)?.games[0]).toMatchObject({status:'Final',home:{score:110}})
    poller.update({...active,online:false});poller.update(active);await vi.advanceTimersByTimeAsync(0)
    expect(updates.at(-1)?.games[0].home.score).toBe(110)
    incoming={...snapshot(),games:[{...game,updatedAt:Date.now(),home:{...game.home,score:111}}]}
    await vi.advanceTimersByTimeAsync(30500)
    expect(updates.at(-1)?.games[0].home.score).toBe(111)
    incoming={...snapshot(),games:[]};await vi.advanceTimersByTimeAsync(30500)
    expect(updates.at(-1)?.games[0].home.score).toBe(111)
    poller.dispose()
})

it('keeps a verified game when an unrelated snapshot row is malformed',()=>{
    const game={id:'nba',nbaId:'0021',espnId:null,status:'InProgress',updatedAt:Date.now(),
        home:{team:'BOS',score:0,players:[]},away:{team:'NYK',score:0,players:[]}}
    expect(readLiveSnapshot({...snapshot(),games:[null,game]},date,Date.now())?.games).toEqual([game])
})
