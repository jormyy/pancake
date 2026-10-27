import { afterEach, describe, expect, it, vi } from 'vitest'
import { beaconScreen, createPerfBeacon, type PerfBeacon } from '@/lib/perf-beacon'

const metadata = { cold: false, device_class: 'phone' as const, connection_type: '4g' as const, app_version: '1.0.0' }
const resource = { startTime: 10, responseEnd: 50, transferSize: 1200, initiatorType: 'fetch' }

function setup(extra: Partial<Parameters<typeof createPerfBeacon>[0]> = {}) {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const send = vi.fn<(rows: PerfBeacon[]) => Promise<unknown>>().mockResolvedValue(undefined)
    let online = true
    const client = createPerfBeacon({ now: () => Date.now(), online: () => online, send,
        schedule: (fn, delay) => setTimeout(fn, delay), cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        random: () => 0, ...extra })
    const paint = (screen = 'roster') => { const open = client.open(screen, 0, metadata); open.painted([resource]); return open }
    return { client, send, paint, offline: () => { online = false } }
}

afterEach(() => vi.useRealTimers())

it.skipIf(process.env.PANCAKE_PERF_BROWSER_TEST !== '1')('observes useful content in a browser', async () => {
    await import('../../supabase/functions/api/beacons/browser-check.mjs')
}, 60_000)

describe('production timing beacons', () => {
    it('batches screens and sends at most once per minute', async () => {
        const { paint, send } = setup()
        vi.setSystemTime(100)
        paint(); paint('players')
        await vi.advanceTimersByTimeAsync(59_899)
        expect(send).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0][0].map(row => row.screen)).toEqual(['roster', 'players'])
        paint()
        await vi.advanceTimersByTimeAsync(59_999)
        expect(send).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(send).toHaveBeenCalledTimes(2)
    })

    it('drops queued and new rows offline without retries', async () => {
        const { paint, send, offline, client } = setup()
        paint(); offline(); client.drop(); paint()
        await vi.advanceTimersByTimeAsync(180_000)
        expect(send).not.toHaveBeenCalled()
    })

    it('drops queued rows when connectivity disappears before flush', async () => {
        const { paint, send, offline } = setup()
        paint(); offline()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(send).not.toHaveBeenCalled()
    })

    it('samples one in N and records the denominator', async () => {
        const random = vi.fn().mockReturnValueOnce(0.1).mockReturnValueOnce(0.099)
        const { client, send } = setup({ sampleN: 10, random })
        const rejected = client.open('roster', 0, metadata)
        expect(rejected.selected).toBe(false)
        rejected.painted([])
        const accepted = client.open('players', 0, metadata)
        expect(accepted.selected).toBe(true)
        accepted.painted([])
        await vi.advanceTimersByTimeAsync(60_000)
        expect(send.mock.calls[0][0]).toEqual([expect.objectContaining({ screen: 'players', sample_n: 10 })])
    })

    it('reduces sampling when the screen volume exceeds twenty per minute', () => {
        const { client } = setup({ random: () => 0.5 })
        for (let n = 0; n < 20; n++) expect(client.open('roster', 0, metadata).selected).toBe(true)
        expect(client.open('roster', 0, metadata).selected).toBe(false)
        vi.setSystemTime(60_000)
        expect(client.open('roster', 0, metadata).selected).toBe(true)
    })

    it('counts completed requests within the content window and marks unknown bytes', async () => {
        const { client, send } = setup()
        vi.setSystemTime(100)
        client.open('roster', 5, metadata).painted([resource,
            { ...resource, startTime: 1 }, { ...resource, responseEnd: 101 },
            { ...resource, initiatorType: 'img' }, { ...resource, transferSize: 0 }])
        await vi.advanceTimersByTimeAsync(59_900)
        expect(send.mock.calls[0][0][0]).toMatchObject({ useful_ms: 95, request_count: 2, transfer_bytes: 1200, bytes_complete: false })
    })

    it('never waits for transport and bounds memory and the request body', async () => {
        const send = vi.fn<(rows: PerfBeacon[]) => Promise<unknown>>(() => new Promise(() => {}))
        const { paint, client } = setup({ send })
        for (let n = 0; n < 50; n++) paint()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0][0]).toHaveLength(20)
        expect(new TextEncoder().encode(JSON.stringify({ member_id: 'a'.repeat(36), beacons: send.mock.calls[0][0] })).length).toBeLessThan(8192)
        expect(paint().painted([])).toBeUndefined()
        await vi.advanceTimersByTimeAsync(180_000)
        expect(send).toHaveBeenCalledTimes(1)
        client.stop()
    })

    it.each(['throw', 'reject'])('absorbs a transport %s without retries', async (mode) => {
        const send = vi.fn(() => { if (mode === 'throw') throw Error('down'); return Promise.reject(Error('down')) })
        const { paint } = setup({ send })
        expect(() => paint()).not.toThrow()
        await vi.advanceTimersByTimeAsync(180_000)
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('absorbs collector failures and ignores cancelled or duplicate paints', async () => {
        const { client, send, paint } = setup()
        const open = paint(); open.painted([])
        const cancelled = client.open('players', 0, metadata); cancelled.cancel(); cancelled.painted([])
        await vi.advanceTimersByTimeAsync(60_000)
        expect(send.mock.calls[0][0]).toHaveLength(1)
        const broken = setup({ online: () => { throw Error('unsupported') } })
        expect(() => broken.paint()).not.toThrow()
    })

    it('drops on teardown and rejects late or negative timings', async () => {
        const { client, send, paint } = setup()
        client.open('players', 10, metadata).painted([])
        vi.setSystemTime(120_001)
        client.open('players', 0, metadata).painted([])
        paint(); client.stop()
        await vi.advanceTimersByTimeAsync(180_000)
        expect(send).not.toHaveBeenCalled()
    })

    it('stores only fixed screen names and strips dynamic ids and query data', () => {
        expect(beaconScreen('/player/private-id?email=secret')).toBe('player')
        expect(beaconScreen('/players?search=secret')).toBe('players')
        expect(beaconScreen('/')).toBe('matchup')
        expect(beaconScreen('/unknown/private-id')).toBeNull()
        expect(beaconScreen('/sign-in')).toBeNull()
    })
})
