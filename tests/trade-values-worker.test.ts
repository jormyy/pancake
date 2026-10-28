import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedTradeValueSnapshot, robotsAllowsTradeValues, syncTradeValues, type TradeValueStore } from '../supabase/functions/_shared/tradeValues'

const fixture = readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
const makeStore = (): TradeValueStore => ({
  claim: vi.fn().mockResolvedValue(true), cached: vi.fn().mockResolvedValue({ matched: 450 }),
  fail: vi.fn().mockResolvedValue(1),
  players: vi.fn().mockResolvedValue([]), overrides: vi.fn().mockResolvedValue({}),
  publish: vi.fn().mockResolvedValue({ players: 450, unmatched: 450, picks: 18 }),
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const fakeClock = () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Signal timed out', 'TimeoutError')), milliseconds)
    return controller.signal
  })
}

const delayedFetcher = (delays: number[]) => vi.fn<typeof fetch>(async (url, options) => {
  if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /')
  return await new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(fixture)), delays.shift()!)
    options?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(options.signal?.reason)
    }, { once: true })
  })
})

describe('trade value sync worker', () => {
  it('publishes a source response that takes sixty seconds', async () => {
    fakeClock()
    const store = makeStore()
    const result = syncTradeValues(store, {}, delayedFetcher([60_000]))
    const outcome = result.then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await outcome).toMatchObject({ value: { players: 450 } })
    expect(store.publish).toHaveBeenCalledOnce()
    expect(store.fail).not.toHaveBeenCalled()
  })
  it('aborts an eighty-second attempt at seventy-five seconds and makes the second attempt', async () => {
    fakeClock()
    const store = makeStore()
    const fetcher = delayedFetcher([80_000, 1_000])
    const outcome = syncTradeValues(store, {}, fetcher).then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(74_999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await outcome).toMatchObject({ value: { players: 450 } })
    expect(store.fail).not.toHaveBeenCalled()
  })
  it('bounds two failed attempts to 110 seconds and schedules one retry without publishing', async () => {
    fakeClock()
    const started = Date.now()
    const store = makeStore()
    const fetcher = delayedFetcher([80_000, 80_000])
    const outcome = syncTradeValues(store, { retry: 2, retryDate: '2026-10-28' }, fetcher).catch(error => error)
    await vi.advanceTimersByTimeAsync(110_000)
    expect(await outcome).toMatchObject({ message: 'OneNumberHoops /api/players fetch failed: Signal timed out' })
    expect(Date.now() - started).toBe(110_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(store.fail).toHaveBeenCalledExactlyOnceWith(expect.any(String), 2, '2026-10-28', true, expect.any(AbortSignal))
    expect(store.publish).not.toHaveBeenCalled()
  })
  it('passes the final retry number to cleanup and still reports failure', async () => {
    fakeClock()
    const store = makeStore()
    const outcome = syncTradeValues(store, { retry: 4, retryDate: '2026-10-28' }, delayedFetcher([80_000, 80_000])).catch(error => error)
    await vi.advanceTimersByTimeAsync(110_000)
    expect(await outcome).toBeInstanceOf(Error)
    expect(store.fail).toHaveBeenCalledExactlyOnceWith(expect.any(String), 4, '2026-10-28', true, expect.any(AbortSignal))
    expect(store.publish).not.toHaveBeenCalled()
  })
  it('gives the second attempt seventy-five seconds when the first fails quickly', async () => {
    fakeClock()
    const store = makeStore()
    const fetcher = delayedFetcher([74_999])
    fetcher.mockResolvedValueOnce(new Response('User-agent: *\nAllow: /'))
    fetcher.mockRejectedValueOnce(new Error('Connection reset'))
    const outcome = syncTradeValues(store, {}, fetcher).then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(76_000)
    expect(await outcome).toMatchObject({ value: { players: 450 } })
  })
  it('keeps robots to five seconds and releases the failed claim', async () => {
    fakeClock()
    const store = makeStore()
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const outcome = syncTradeValues(store, {}, fetcher).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await outcome).toMatchObject({ message: 'OneNumberHoops /robots.txt fetch failed: Signal timed out' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(store.fail).toHaveBeenCalledExactlyOnceWith(expect.any(String), 0, null, true, expect.any(AbortSignal))
  })
  it('includes stalled body reads in the fetch timeout', async () => {
    fakeClock()
    const store = makeStore()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('User-agent: *\nAllow: /'))
      .mockImplementation(async () => ({ ok: true, text: () => new Promise(() => {}) }) as Response)
    const outcome = syncTradeValues(store, {}, fetcher).catch(error => error)
    await vi.advanceTimersByTimeAsync(110_000)
    expect(await outcome).toBeInstanceOf(Error)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(store.fail).toHaveBeenCalledOnce()
  })
  it('bounds database work and cleanup to 120 seconds while preserving the error', async () => {
    fakeClock()
    const store = makeStore()
    vi.mocked(store.players).mockImplementation(() => new Promise(() => {}))
    vi.mocked(store.fail).mockImplementation(() => new Promise(() => {}))
    const outcome = syncTradeValues(store, {}, delayedFetcher([1])).catch(error => error)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await outcome).toMatchObject({ message: expect.stringContaining('Signal timed out; retry cleanup failed:') })
    expect(store.publish).not.toHaveBeenCalled()
  })
  it('checks robots before fetching and publishes one complete scaled snapshot', async () => {
    const store = makeStore()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('User-agent: *\nAllow: /'))
      .mockResolvedValueOnce(new Response(fixture))
    await syncTradeValues(store, {}, fetcher)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['https://www.onenumberhoops.com/robots.txt', 'https://www.onenumberhoops.com/api/players'])
    expect(store.publish).toHaveBeenCalledWith(expect.objectContaining({ rows: expect.arrayContaining([expect.objectContaining({ value: 999.9 })]), picks: expect.any(Array), mode: 'live' }), expect.any(AbortSignal))
    expect(fetcher.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true)
  })
  it('serves the cache without any source requests when the daily claim is unavailable', async () => {
    const store = makeStore()
    vi.mocked(store.claim).mockResolvedValue(false)
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('No network allowed'))
    expect(await syncTradeValues(store, {}, fetcher)).toEqual({ cached: true, snapshot: { matched: 450 } })
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.publish).not.toHaveBeenCalled()
  })
  it('stops on blocked robots, failed HTTP, and broken source contracts', async () => {
    for (const responses of [
      [new Response('User-agent: *\nDisallow: /api/')],
      [new Response('', { status: 429 })],
      [new Response('User-agent: *\nAllow: /'), new Response('{"success":true,"data":[]}')],
    ]) {
      const store = makeStore()
      const fetcher = vi.fn<typeof fetch>()
      for (const response of responses) fetcher.mockResolvedValueOnce(response)
      await expect(syncTradeValues(store, {}, fetcher)).rejects.toThrow()
      expect(store.publish).not.toHaveBeenCalled()
    }
  })
  it('imports recorded source JSON without network or daily-fetch claims', async () => {
    const store = makeStore()
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('No network allowed'))
    await syncTradeValues(store, { format: 'json', content: fixture }, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.claim).not.toHaveBeenCalled()
    expect(store.publish).toHaveBeenCalledOnce()
  })
  it('rejects unknown import formats and missing data', async () => {
    for (const input of [{ format: 'csv' }, { format: 'something' }]) await expect(syncTradeValues(makeStore(), input)).rejects.toThrow()
  })
  it('does not turn a failed daily attempt into a successful cache result', () => {
    expect(() => cachedTradeValueSnapshot({ fetched_at: null, last_request_at: null, matched: null })).toThrow('did not publish')
    expect(() => cachedTradeValueSnapshot({ fetched_at: '2026-10-27T08:00:00Z', last_request_at: '2026-10-28T08:00:00Z', matched: 445 })).toThrow('did not publish')
    expect(cachedTradeValueSnapshot({ fetched_at: '2026-10-28T08:01:00Z', last_request_at: '2026-10-28T08:00:00Z', matched: 445 })).toEqual({ fetchedAt: '2026-10-28T08:01:00Z', matched: 445 })
  })
})

describe('robots policy', () => {
  it('honors matching paths, specific agents, wildcards, and allow precedence', () => {
    expect(robotsAllowsTradeValues('User-agent: *\nDisallow: /api/')).toBe(false)
    expect(robotsAllowsTradeValues('User-agent: *\nDisallow: /api/*\nAllow: /api/players$')).toBe(true)
    expect(robotsAllowsTradeValues('User-agent: *\nAllow: /\nUser-agent: Pancake\nDisallow: /')).toBe(false)
    expect(robotsAllowsTradeValues('User-agent: *\nDisallow: /private/')).toBe(true)
  })
})
